// Ostiarius server entry — 会場LANチェックインゲートウェイ。
//
// 役割 (CONTRACTS.md §3 / spike gateway-server.ts の昇格版):
//   - Cernere から passkey 公開鍵を同期 (起動時 + 定期) してオフライン検証を成立させる
//   - PWA から来た passkey assertion を「同期済み公開鍵」だけで検証する
//     (= Cernere に都度問い合わせない。 家からは LAN に届かないので成立しない)
//   - 検証 OK なら presence-attestation を自鍵 (Ed25519) で署名して返す
//
// 起動シーケンス:
//   1. env (config.ts) を確定
//   2. SQLite 開いて schema 適用
//   3. Ed25519 attestation 鍵を load/create → 公開鍵 PEM をログ出力
//   4. Cernere passkey sync を start (起動時 1 回 + interval)
//   5. router を mount → listen

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';

import { loadConfig } from './config.ts';
import { openDb, countCredentials, countFaceTemplates, countOutbox, rotateFaceEvents } from './db.ts';
import { loadOrCreateKeyPair } from './attestation-key.ts';
import { startCernereSync } from './cernere-sync.ts';
import { registerGatewayKey } from './aedilis-register.ts';
import { ChallengeStore } from './challenge-store.ts';
import { IdentitySessionStore } from './identity-session-store.ts';
import { KioskAuthorization } from './kiosk-authorization.ts';
import { makeCheckinRouter } from './routes/checkin.ts';
import { makeMobileCheckinRouter } from './routes/mobile-checkin.ts';
import { makeIdentityRouter } from './routes/identity.ts';
import { makeKioskRouter } from './routes/kiosk.ts';
import { createVantanUserClient } from './vantan-user-client.ts';
import { createSidecarClient } from './face/sidecar-client.ts';
import { buildFaceRoster } from './face/template-roster.ts';
import { FaceVerificationFlow } from './face/verification-flow.ts';
import { makeIdentityFaceRouter } from './routes/identity-face.ts';
import { retryOutbox } from './face/aedilis-outbox.ts';
import { StaffSessionStore } from './face/staff-session.ts';
import { EnrollmentSessionStore } from './face/enrollment-session.ts';
import { makeIdentityStaffRouter } from './routes/identity-staff.ts';
import { makeIdentityEnrollRouter } from './routes/identity-enroll.ts';
import { CernereConsentClient } from './face/cernere-consent-client.ts';
import { retryConsentRevocations } from './face/consent-outbox.ts';
import { loadLocalFaceKeys } from './face/local-key.ts';
import { createLanGuard } from './face/lan-guard.ts';
import { syncFaceData } from './face/revocation-sync.ts';
import { startFaceBackup } from './face/backup.ts';
import { FaceReviewService } from './face/review-service.ts';
import { makeIdentityReviewRouter } from './routes/identity-review.ts';
import { createServiceTokenProvider, staticServiceTokenProvider, type ServiceTokenProvider } from './cernere-service-token.ts';

const config = loadConfig();
const db = openDb(config.dbPath);
const identitySessions = new IdentitySessionStore();
const kioskAuthorization = new KioskAuthorization(config.kioskToken);
const keyPair = loadOrCreateKeyPair({
  privateKeyPem: config.privateKeyPem,
  keyPath: config.keyPath,
});
const challenges = new ChallengeStore(config.challengeTtlMs);
// 顔データの封緘鍵はこのホストで生成・保管する (env / Infisical からは配らない)。
const faceKeys = loadLocalFaceKeys(config.dataDir);
const isLan = createLanGuard();
const sidecar = createSidecarClient(config.faceSidecarUrl);
const staffSessions = new StaffSessionStore();
const enrollment = new EnrollmentSessionStore();
const MODEL_ID = 'insightface/glintr100@1';
const faceFlow = new FaceVerificationFlow({ db, sessions: identitySessions, sidecar, roster: () => buildFaceRoster(db, faceKeys, MODEL_ID), threshold: config.faceMatchThreshold, margin: config.faceMargin, livenessThreshold: config.livenessThreshold, challengeRequired: config.faceChallengeRequired, subjectHint: (userId) => `ID / ${userId.slice(-2)}` });

// service token は project client credential から都度取り直す (TTL 60 分)。
// 固定 token は運用者の一時確認用の逃げ道として残す。
const cernereServiceToken: ServiceTokenProvider = config.cernereProjectClientId && config.cernereProjectClientSecret
  ? createServiceTokenProvider({
    cernereBaseUrl: config.cernereBaseUrl,
    clientId: config.cernereProjectClientId,
    clientSecret: config.cernereProjectClientSecret,
  })
  : staticServiceTokenProvider(config.cernereServiceToken);

// Cernere から取り込むのは失効指示と同意だけ (顔テンプレートの正本はローカル)。
const consentClient = new CernereConsentClient({
  baseUrl: config.cernereBaseUrl,
  serviceToken: cernereServiceToken,
  facilityId: config.facilityId,
});
const syncFaceNow = (): Promise<unknown> => syncFaceData({
  db,
  baseUrl: config.cernereBaseUrl,
  serviceToken: cernereServiceToken,
  facilityId: config.facilityId,
});

startCernereSync({
  db,
  cernereBaseUrl: config.cernereBaseUrl,
  serviceToken: cernereServiceToken,
  intervalMs: config.syncIntervalMs,
  faceSync: config.consentSource === 'cernere' ? syncFaceNow : undefined,
});

// 施設内バックアップ (日次・7 世代)。未設定なら運用者がまだ媒体を決めていないということ。
if (config.backupDir) startFaceBackup(db, { backupDir: config.backupDir, dataDir: config.dataDir });
else console.warn('[ostiarius] OSTIARIUS_BACKUP_DIR 未設定 → 施設内バックアップは無効 (ホスト故障時は全員再登録になります)');

// vantan_user プロフィール enrichment (モバイルチェックイン確認画面の department/grade/name 表示) は
// 任意機能 — CERNERE_PROJECT_CLIENT_ID/_SECRET 未設定なら createVantanUserClient が null を
// 返し、 以後は enrichment を丸ごとスキップする (コアのチェックインは影響を受けない)。
const vantanUserClient = createVantanUserClient({
  cernereBaseUrl: config.cernereBaseUrl,
  clientId: config.cernereProjectClientId,
  clientSecret: config.cernereProjectClientSecret,
});
if (vantanUserClient) {
  vantanUserClient.start();
} else {
  console.warn('[ostiarius] CERNERE_PROJECT_CLIENT_ID/_SECRET 未設定 → vantan_user プロフィール enrichment は無効 (モバイルチェックインは department/grade/name を表示しません)');
}

const app = new Hono();

// CORS は PWA の origin のみ許可 (CONTRACTS §3: 全 API に CORS)
app.use(
  '*',
  cors({
    origin: config.pwaOrigin,
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['content-type', 'authorization', 'x-ostiarius-staff'],
  }),
);

app.get('/api/health', async (c) => {
  const sidecarHealth = await sidecar.health().catch(() => ({ ok: false, modelId: '' }));
  return c.json({
    ok: true,
    service: 'ostiarius',
    lanId: config.lanId,
    facilityId: config.facilityId,
    credentials: countCredentials(db),
    faceTemplates: countFaceTemplates(db, 'active'),
    facePending: countFaceTemplates(db, 'pending'),
    sidecar: sidecarHealth,
    outbox: countOutbox(db),
    methods: ['passkey', ...config.legacyMethods.filter((method) => method === 'session' || method === 'password')],
  });
});

app.route(
  '/',
  makeCheckinRouter({
    db,
    challenges,
    lanId: config.lanId,
    facilityId: config.facilityId,
    rpId: config.rpId,
    pwaOrigin: config.pwaOrigin,
    privateKey: keyPair.privateKey,
    publicKeyPem: keyPair.publicKeyPem,
  }),
);

app.route('/', makeIdentityRouter({
  db, challenges, lanId: config.lanId, facilityId: config.facilityId, rpId: config.rpId,
  pwaOrigin: config.pwaOrigin, privateKey: keyPair.privateKey, cernereFrontendUrl: config.cernereFrontendUrl,
  kioskAuthorization, sessions: identitySessions,
}));
app.route('/', makeKioskRouter({
  authorization: kioskAuthorization,
  pwaOrigin: config.pwaOrigin,
  sessions: identitySessions,
}));
app.route('/', makeIdentityFaceRouter({ db, flow: faceFlow, authorization: kioskAuthorization, privateKey: keyPair.privateKey, lanId: config.lanId, facilityId: config.facilityId, aedilisBaseUrl: config.aedilisBaseUrl, aedilisGatewayToken: config.aedilisGatewayToken }));
app.route('/', makeIdentityStaffRouter({ db, challenges, lanId: config.lanId, facilityId: config.facilityId, rpId: config.rpId, pwaOrigin: config.pwaOrigin, privateKey: keyPair.privateKey, staffRoles: config.staffRoles, sessions: staffSessions, aedilisBaseUrl: config.aedilisBaseUrl, aedilisGatewayToken: config.aedilisGatewayToken, dailyOverrideLimit: config.dailyOverrideLimit, keys: faceKeys, isLan, syncNow: syncFaceNow }));
app.route('/', makeIdentityEnrollRouter({ db, sidecar, staff: staffSessions, enrollment, keys: faceKeys, modelId: MODEL_ID, facilityId: config.facilityId, consentSource: config.consentSource, baseUrl: config.cernereBaseUrl, serviceToken: cernereServiceToken, isLan }));
app.route('/', makeIdentityReviewRouter({
  db,
  staff: staffSessions,
  review: new FaceReviewService({ db, keys: faceKeys, enrollment, modelId: MODEL_ID, facilityId: config.facilityId }),
  enrollment,
  cernereBaseUrl: config.cernereBaseUrl,
  serviceToken: cernereServiceToken,
  facilityId: config.facilityId,
  staffRoles: config.staffRoles,
  shotsRequired: 6,
  consentSource: config.consentSource,
  isLan,
}));
if (config.aedilisBaseUrl && config.aedilisGatewayToken) setInterval(() => { void retryOutbox(db, config.aedilisBaseUrl, config.aedilisGatewayToken); }, 30_000).unref?.();
// 同意撤回の再送 (ローカル削除は済んでいる。Cernere 側の同意へ revokedAt を打つだけ)。
if (config.consentSource === 'cernere') setInterval(() => { void retryConsentRevocations(db, consentClient); }, 60_000).unref?.();
rotateFaceEvents(db, config.eventRetentionDays);
setInterval(() => rotateFaceEvents(db, config.eventRetentionDays), 86_400_000).unref?.();

// PC無し/未登録passkey来場者向けフォールバック (Ostiarius 自身の origin で配信 = CORS 不要)。
app.route(
  '/',
  makeMobileCheckinRouter({
    wifiSsid: config.wifiSsid,
    wifiPassword: config.wifiPassword,
    aedilisBaseUrl: config.aedilisBaseUrl,
    sessionCheckinEnabled: config.legacyMethods.includes('session'),
    passwordCheckinEnabled: config.legacyMethods.includes('password'),
    loginDeps: {
      cernereBaseUrl: config.cernereBaseUrl,
      facilityId: config.facilityId,
      lanId: config.lanId,
      challenges,
      privateKey: keyPair.privateKey,
      vantanUserClient,
      db,
    },
  }),
);

app.notFound((c) => c.json({ error: 'not_found' }, 404));

// 公開鍵の Aedilis 自己登録 (#167)。 env が両方そろっていれば起動後に登録、
// 無ければ手動 provision (起動ログの PEM を運用者が登録) にフォールバックする。
function provisionGatewayKey(): void {
  const canSelfRegister = Boolean(config.aedilisBaseUrl && config.aedilisAdminToken);
  if (canSelfRegister) {
    console.log(`[ostiarius] 公開鍵を Aedilis に自己登録します: ${config.aedilisBaseUrl}`);
    void registerGatewayKey({
      baseUrl: config.aedilisBaseUrl,
      adminToken: config.aedilisAdminToken,
      lanId: config.lanId,
      facilityId: config.facilityId,
      publicKeyPem: keyPair.publicKeyPem,
      label: config.label,
    });
    return;
  }
  // 手動 provision フォールバック — 運用者がこの PEM を登録する。
  console.log('[ostiarius] AEDILIS_BASE_URL / AEDILIS_ADMIN_TOKEN 未設定 → 手動 provision');
  console.log('[ostiarius] ── gateway public key (PEM) — Aedilis の POST /api/admin/gateways に登録 ──');
  console.log(keyPair.publicKeyPem.trim());
  console.log('[ostiarius] ──────────────────────────────────────────────────────────────────');
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[ostiarius] listening on http://0.0.0.0:${info.port}`);
  console.log(`[ostiarius] lanId=${config.lanId} facilityId=${config.facilityId}`);
  console.log(`[ostiarius] rpId=${config.rpId} pwaOrigin=${config.pwaOrigin}`);
  console.log(`[ostiarius] cernere=${config.cernereBaseUrl}`);
  console.log(`[ostiarius] key source=${keyPair.source}`);
  console.log(`[ostiarius] credentials cached: ${countCredentials(db)}`);
  console.log(
    `[ostiarius] mobile-checkin: wifiQr=${config.wifiSsid ? 'on' : 'off'} vantanUserEnrichment=${vantanUserClient ? 'on' : 'off'} aedilis=${config.aedilisBaseUrl || '(未設定)'}`,
  );
  provisionGatewayKey();
});
