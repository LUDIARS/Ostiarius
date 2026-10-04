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
import { serve } from '@hono/node-server';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';

import { loadConfig } from './config.ts';
import { openDb, countCredentials, countFaceTemplates, countOutbox, rotateFaceEvents } from './db.ts';
import { loadOrCreateKeyPair } from './attestation-key.ts';
import { startCernereSync } from './cernere-sync.ts';
import { registerGatewayKey } from './aedilis-register.ts';
import { ChallengeStore } from './challenge-store.ts';
import { IdentitySessionStore } from './identity-session-store.ts';
import { KioskAuthorization } from './kiosk-authorization.ts';
import { makeCheckinRouter } from './routes/checkin.ts';
import { attendanceSender } from './attendance-delivery.ts';
import { makeCocoiruCheckinRouter } from './routes/cocoiru-checkin.ts';
import { makeMobileCheckinRouter } from './routes/mobile-checkin.ts';
import { makeIdentityRouter } from './routes/identity.ts';
import { makeKioskRouter } from './routes/kiosk.ts';
import { createVantanUserClient } from './vantan-user-client.ts';
import { createLanBaseUrlResolver } from './lan-route.ts';
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
import { createLanGuard, createSecureLanGuard } from './face/lan-guard.ts';
import { installLanHardening } from './http-security/install.ts';
import { SECURE_CONTEXT_METHODS } from './http-security/secure-context.ts';
import { syncFaceData } from './face/revocation-sync.ts';
import { startFaceBackup } from './face/backup.ts';
import { FaceReviewService } from './face/review-service.ts';
import { makeIdentityReviewRouter } from './routes/identity-review.ts';
import { createServiceTokenProvider, staticServiceTokenProvider, type ServiceTokenProvider } from './cernere-service-token.ts';
import { PasskeyCheckinService } from './passkey-checkin.ts';
import { OnsiteMfaSessionStore } from './onsite-mfa/session-store.ts';
import { onsiteMfaSubmitter } from './onsite-mfa/cernere-submit.ts';
import { makeOnsiteMfaRouter, ONSITE_MFA_API_PREFIX } from './routes/onsite-mfa.ts';
import { makeOnsiteMfaKioskRouter } from './routes/onsite-mfa-kiosk.ts';

const config = loadConfig();
// Explicit venue-interface enrollment keeps this new flow separate from legacy session check-in.
const cocoiruInterface = process.env.OSTIARIUS_COCOIRU_LAN_INTERFACE?.trim();
if (cocoiruInterface && !config.tls.enabled) {
  throw new Error('Cocoiru attendance requires OSTIARIUS_TLS_MODE=required and a venue certificate');
}

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
// 写真・テンプレート・登録系は LAN 内でも平文の別端末へ流さない (TLS か loopback)。
const isSecureLan = createSecureLanGuard();
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

const stopCernereSync = startCernereSync({
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

// HTTP の LAN 内サービスとしての防御 (spec/feature/lan-https-and-lan-url.md §8)。
// CORS は PWA の origin のみ許可 (CONTRACTS §3)。現地確認 MFA の端末向け API は Cernere の
// 画面から呼ばれるので、Cernere の公開 origin だけを許可し、ヘッダ付与はその router に任せる。
installLanHardening(app, {
  port: config.port,
  lanHostname: config.tls.enabled ? config.tls.hostname : config.lanHostname,
  corsOrigins: [config.pwaOrigin],
  corsScopes: [{ pathPrefix: ONSITE_MFA_API_PREFIX, origins: [config.cernereFrontendUrl], corsHeaders: 'router' }],
  isLan,
});

// 会場端末の接続先は日によって変わる。 /api/health は Excubitor が定期的に叩くので、
// 検出結果は TTL キャッシュして毎回 UDP socket を張らない (lan-route.ts)。
const resolveLanBaseUrl = createLanBaseUrlResolver(config.port, {
  protocol: config.tls.enabled ? 'https' : 'http',
  hostname: config.tls.enabled ? config.tls.hostname : undefined,
});

app.get('/api/health', async (c) => {
  const sidecarHealth = await sidecar.health().catch(() => ({ ok: false, modelId: '' }));
  const lanUrl = await resolveLanBaseUrl();
  return c.json({
    ok: true,
    service: 'ostiarius',
    version: process.env.npm_package_version ?? '0.1.0',
    lanUrl,
    lanId: config.lanId,
    facilityId: config.facilityId,
    credentials: countCredentials(db),
    faceTemplates: countFaceTemplates(db, 'active'),
    facePending: countFaceTemplates(db, 'pending'),
    sidecar: sidecarHealth,
    outbox: countOutbox(db),
    // パスワード / Bearer を送る互換経路は TLS のときだけ使える (平文 LAN では 403)。
    methods: ['passkey', ...(config.tls.enabled ? config.legacyMethods.filter((method) => method === 'session' || method === 'password') : [])],
    lanTransport: config.tls.enabled ? 'https' : 'http',
    // この一覧の手段は secure context (HTTPS か localhost) の画面でしか出さない。
    secureContextMethods: SECURE_CONTEXT_METHODS,
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
    sendAttendance: attendanceSender(config.aedilisBaseUrl, config.aedilisGatewayToken),
  }),
);

// kiosk 画面は cookie の Path (/kiosk) に収まる `/kiosk/identity/*` から同じ router を使う。
const identityRouter = makeIdentityRouter({
  db, challenges, lanId: config.lanId, facilityId: config.facilityId, rpId: config.rpId,
  pwaOrigin: config.pwaOrigin, privateKey: keyPair.privateKey, cernereFrontendUrl: config.cernereFrontendUrl,
  kioskAuthorization, sessions: identitySessions,
  sendAttendance: attendanceSender(config.aedilisBaseUrl, config.aedilisGatewayToken),
});
app.route('/', identityRouter);
app.route('/kiosk', identityRouter);
app.route('/', makeKioskRouter({
  authorization: kioskAuthorization,
  pwaOrigin: config.pwaOrigin,
  sessions: identitySessions,
}));
const identityFaceRouter = makeIdentityFaceRouter({ db, flow: faceFlow, authorization: kioskAuthorization, privateKey: keyPair.privateKey, lanId: config.lanId, facilityId: config.facilityId, aedilisBaseUrl: config.aedilisBaseUrl, aedilisGatewayToken: config.aedilisGatewayToken });
app.route('/', identityFaceRouter);
app.route('/kiosk', identityFaceRouter);
app.route('/', makeIdentityStaffRouter({ db, challenges, lanId: config.lanId, facilityId: config.facilityId, rpId: config.rpId, pwaOrigin: config.pwaOrigin, privateKey: keyPair.privateKey, staffRoles: config.staffRoles, sessions: staffSessions, aedilisBaseUrl: config.aedilisBaseUrl, aedilisGatewayToken: config.aedilisGatewayToken, dailyOverrideLimit: config.dailyOverrideLimit, keys: faceKeys, isLan: isSecureLan, syncNow: syncFaceNow }));
app.route('/', makeIdentityEnrollRouter({ db, sidecar, staff: staffSessions, enrollment, keys: faceKeys, modelId: MODEL_ID, facilityId: config.facilityId, consentSource: config.consentSource, baseUrl: config.cernereBaseUrl, serviceToken: cernereServiceToken, isLan: isSecureLan }));
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
  isLan: isSecureLan,
}));
// 現地確認 MFA (spec/feature/onsite-mfa-factor.md §2.1)。attestation は purpose:"mfa" で署名し、
// Cernere へだけ送る。パスキーは出席を送らない専用インスタンスで検証する。
const onsiteMfaSessions = new OnsiteMfaSessionStore();
app.route('/', makeOnsiteMfaRouter({ sessions: onsiteMfaSessions, isLan, corsOrigin: config.cernereFrontendUrl }));
app.route('/', makeOnsiteMfaKioskRouter({
  authorization: kioskAuthorization,
  flow: faceFlow,
  passkey: new PasskeyCheckinService({ db, challenges, lanId: config.lanId, facilityId: config.facilityId, rpId: config.rpId, pwaOrigin: config.pwaOrigin, privateKey: keyPair.privateKey }),
  completion: {
    sessions: onsiteMfaSessions,
    privateKey: keyPair.privateKey,
    lanId: config.lanId,
    facilityId: config.facilityId,
    submit: onsiteMfaSubmitter({ cernereBaseUrl: config.cernereBaseUrl, serviceToken: cernereServiceToken }),
  },
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
    sendAttendance: attendanceSender(config.aedilisBaseUrl, config.aedilisGatewayToken),
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

if (cocoiruInterface) app.route('/', makeCocoiruCheckinRouter({
  interfaceName: cocoiruInterface,
  login: { cernereBaseUrl: config.cernereBaseUrl, facilityId: config.facilityId,
    lanId: config.lanId, challenges, privateKey: keyPair.privateKey, vantanUserClient: null, db },
}));

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

function onListening(info: AddressInfo): void {
  const protocol = config.tls.enabled ? 'https' : 'http';
  console.log(`[ostiarius] listening on ${protocol}://0.0.0.0:${info.port}`);
  console.log(`[ostiarius] lanId=${config.lanId} facilityId=${config.facilityId}`);
  console.log(`[ostiarius] rpId=${config.rpId} pwaOrigin=${config.pwaOrigin}`);
  console.log(`[ostiarius] cernere=${config.cernereBaseUrl}`);
  console.log(`[ostiarius] key source=${keyPair.source}`);
  console.log(`[ostiarius] credentials cached: ${countCredentials(db)}`);
  console.log(
    `[ostiarius] mobile-checkin: wifiQr=${config.wifiSsid ? 'on' : 'off'} vantanUserEnrichment=${vantanUserClient ? 'on' : 'off'} aedilis=${config.aedilisBaseUrl || '(未設定)'}`,
  );
  provisionGatewayKey();
}

// TLS を有効にした会場では HTTP へ落ちない (resolveTlsConfig が不完全な設定で起動を止める)。
// 証明書は server/acme の CLI が発行し、運用者が Infisical へ登録したものを受け取る。
const server = config.tls.enabled
  ? serve({
    fetch: app.fetch,
    port: config.port,
    createServer: createHttpsServer,
    serverOptions: {
      cert: config.tls.certificatePem,
      key: config.tls.privateKeyPem,
    },
  }, onListening)
  : serve({ fetch: app.fetch, port: config.port }, onListening);

// Excubitor の再起動で listen socket と Cernere WS を確実に手放す
// (TLS listener を握ったままだと次の起動が同じ port を掴めない)。
let isShuttingDown = false;
function shutdown(): void {
  if (isShuttingDown) return;
  isShuttingDown = true;
  stopCernereSync();
  vantanUserClient?.close();
  server.close();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
