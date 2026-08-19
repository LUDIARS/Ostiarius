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
import { syncFaceTemplates } from './face/template-sync.ts';
import { StaffSessionStore } from './face/staff-session.ts';
import { EnrollmentSessionStore } from './face/enrollment-session.ts';
import { makeIdentityStaffRouter } from './routes/identity-staff.ts';
import { makeIdentityEnrollRouter } from './routes/identity-enroll.ts';
import { createCernerePhotoClient } from './face/cernere-photo-client.ts';
import { CernereTemplateClient } from './face/cernere-template-client.ts';
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
if (config.templateKey.length !== 32) throw new Error('OSTIARIUS_TEMPLATE_KEY must be a base64-encoded 32-byte key');
const sidecar = createSidecarClient(config.faceSidecarUrl);
const staffSessions = new StaffSessionStore();
const enrollment = new EnrollmentSessionStore();
const faceFlow = new FaceVerificationFlow({ db, sessions: identitySessions, sidecar, roster: () => buildFaceRoster(db, config.templateKey, 'insightface/glintr100@1'), threshold: config.faceMatchThreshold, margin: config.faceMargin, livenessThreshold: config.livenessThreshold, challengeRequired: config.faceChallengeRequired, subjectHint: (userId) => `ID / ${userId.slice(-2)}` });

// service token は project client credential から都度取り直す (TTL 60 分)。
// 固定 token は運用者の一時確認用の逃げ道として残す。
const cernereServiceToken: ServiceTokenProvider = config.cernereProjectClientId && config.cernereProjectClientSecret
  ? createServiceTokenProvider({
    cernereBaseUrl: config.cernereBaseUrl,
    clientId: config.cernereProjectClientId,
    clientSecret: config.cernereProjectClientSecret,
  })
  : staticServiceTokenProvider(config.cernereServiceToken);

startCernereSync({
  db,
  cernereBaseUrl: config.cernereBaseUrl,
  serviceToken: cernereServiceToken,
  intervalMs: config.syncIntervalMs,
});
// 承認直後に施設キャッシュへ反映するため、定期同期と同じ処理を関数として持つ。
const syncTemplatesNow = (): Promise<{ ok: boolean; synced: number }> => syncFaceTemplates({
  db,
  baseUrl: config.cernereBaseUrl,
  serviceToken: cernereServiceToken,
  facilityId: config.facilityId,
  key: config.templateKey,
});
if (config.faceTemplateSource === 'cernere') {
  void syncTemplatesNow();
  setInterval(() => { void syncTemplatesNow(); }, config.syncIntervalMs).unref?.();
}

// 写真取得・審査は scope 付き token と Cernere 上の審査者 userId が揃って初めて有効。
// 欠けている場合は承認パネルも API も出さない (権限が無いまま画面だけ出さない)。
const facePhotoClient = createCernerePhotoClient({
  baseUrl: config.cernereBaseUrl,
  token: config.cernereFacePhotoToken,
  facilityId: config.facilityId,
  reviewerUserId: config.cernereReviewerUserId,
});
if (!facePhotoClient) {
  console.warn('[ostiarius] CERNERE_FACE_PHOTO_TOKEN / OSTIARIUS_FACE_REVIEWER_USER_ID 未設定 → 写真由来 pending の職員承認は無効 (従来の職員立会い登録は利用できます)');
}

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
    faceTemplates: countFaceTemplates(db),
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
  reviewEnabled: Boolean(facePhotoClient),
}));
app.route('/', makeIdentityFaceRouter({ db, flow: faceFlow, authorization: kioskAuthorization, privateKey: keyPair.privateKey, lanId: config.lanId, facilityId: config.facilityId, aedilisBaseUrl: config.aedilisBaseUrl, aedilisGatewayToken: config.aedilisGatewayToken }));
app.route('/', makeIdentityStaffRouter({ db, challenges, lanId: config.lanId, facilityId: config.facilityId, rpId: config.rpId, pwaOrigin: config.pwaOrigin, privateKey: keyPair.privateKey, staffRoles: config.staffRoles, sessions: staffSessions, aedilisBaseUrl: config.aedilisBaseUrl, aedilisGatewayToken: config.aedilisGatewayToken, dailyOverrideLimit: config.dailyOverrideLimit }));
app.route('/', makeIdentityEnrollRouter({ db, sidecar, staff: staffSessions, enrollment, key: config.templateKey, modelId: 'insightface/glintr100@1', source: config.faceTemplateSource, baseUrl: config.cernereBaseUrl, serviceToken: cernereServiceToken, facilityId: config.facilityId }));
if (facePhotoClient) {
  app.route('/', makeIdentityReviewRouter({
    db,
    staff: staffSessions,
    photos: facePhotoClient,
    review: new FaceReviewService({
      db,
      photos: facePhotoClient,
      templates: new CernereTemplateClient({ baseUrl: config.cernereBaseUrl, serviceToken: cernereServiceToken, facilityId: config.facilityId }),
      enrollment,
      key: config.templateKey,
      modelId: 'insightface/glintr100@1',
      reviewerUserId: config.cernereReviewerUserId,
      syncNow: syncTemplatesNow,
    }),
    enrollment,
    cernereBaseUrl: config.cernereBaseUrl,
    serviceToken: cernereServiceToken,
    facilityId: config.facilityId,
    staffRoles: config.staffRoles,
    shotsRequired: 6,
  }));
}
if (config.aedilisBaseUrl && config.aedilisGatewayToken) setInterval(() => { void retryOutbox(db, config.aedilisBaseUrl, config.aedilisGatewayToken); }, 30_000).unref?.();
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
