// env 解決 — CONTRACTS.md §3 の config 表に対応。
//
// listen port / data dir / 鍵パス / sync 間隔は default を許す (= サービスとして成立)。
// 認証・同期に必須なもの (LAN_ID / FACILITY_ID / CERNERE_* / RP_ID / PWA_ORIGIN) は
// 未設定なら起動を止める — 不正な値で起動して全 check-in が失敗するより明示的に落とす。

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(
      `[ostiarius] ${name} が未設定です。 .env.secrets / .env / host env のいずれかで指定してください。`,
    );
    process.exit(1);
  }
  return v.trim();
}

function optionalEnv(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

function normalizeHttpOrigin(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) origin`);
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be an HTTP(S) origin without credentials, path, query, or fragment`);
  }
  return url.origin;
}

export interface OstiariusConfig {
  port: number;
  lanId: string;
  facilityId: string;
  cernereBaseUrl: string;
  cernereFrontendUrl: string;
  cernereServiceToken: string;
  rpId: string;
  pwaOrigin: string;
  keyPath: string;
  /** OSTIARIUS_PRIVATE_KEY — Infisical inject の PKCS#8 PEM (本番、 空なら file 経路) */
  privateKeyPem: string;
  /** AEDILIS_BASE_URL — 公開鍵 自己登録の宛先 (空なら自己登録しない) */
  aedilisBaseUrl: string;
  /** AEDILIS_ADMIN_TOKEN — 自己登録に使う admin Bearer (空なら自己登録しない) */
  aedilisAdminToken: string;
  /** Aedilis に出すゲートウェイ表示ラベル */
  label: string;
  dataDir: string;
  dbPath: string;
  syncIntervalMs: number;
  challengeTtlMs: number;
  /** OSTIARIUS_WIFI_SSID — 会場 Wi-Fi QR に載せる SSID (空なら QR セクションを出さない、任意機能) */
  wifiSsid: string;
  /** OSTIARIUS_WIFI_PASSWORD — 同上のパスワード (空可、SSID が空ならどのみち未使用) */
  wifiPassword: string;
  /** OSTIARIUS_CERNERE_PROJECT_CLIENT_ID — vantan_user プロフィール読取用 Cernere project client_id
   *  (空なら vantan-user-client.ts の createVantanUserClient が null を返し enrichment を丸ごとスキップする。
   *   モバイルチェックイン本体 (login + attestation + Aedilis verify) には影響しない) */
  cernereProjectClientId: string;
  /** OSTIARIUS_CERNERE_PROJECT_CLIENT_SECRET — 同上の client_secret (secret) */
  cernereProjectClientSecret: string;
  /** OSTIARIUS_LEGACY_METHODS — 明示的に許可した旧来の本人確認経路。既定は全て無効。 */
  legacyMethods: readonly string[];
  kioskToken: string;
  templateKey: Buffer;
  faceSidecarUrl: string;
  faceMatchThreshold: number;
  faceMargin: number;
  livenessThreshold: number;
  faceChallengeRequired: boolean;
  faceTemplateSource: 'cernere' | 'local';
  aedilisGatewayToken: string;
  staffRoles: readonly string[];
  eventRetentionDays: number;
  dailyOverrideLimit: number;
}

export function loadConfig(): OstiariusConfig {
  const dataDir = resolve(optionalEnv('OSTIARIUS_DATA', join(__dirname, '..', 'data')));
  const cernereBaseUrl = requireEnv('CERNERE_BASE_URL').replace(/\/+$/, '');
  const configuredFrontendUrl = process.env.CERNERE_FRONTEND_URL?.trim();
  const cernereFrontendUrl = configuredFrontendUrl
    ? normalizeHttpOrigin('CERNERE_FRONTEND_URL', configuredFrontendUrl)
    : normalizeHttpOrigin('CERNERE_BASE_URL', new URL(cernereBaseUrl).origin);
  return {
    port: Number(optionalEnv('OSTIARIUS_PORT', '17590')),
    lanId: requireEnv('OSTIARIUS_LAN_ID'),
    facilityId: requireEnv('OSTIARIUS_FACILITY_ID'),
    cernereBaseUrl,
    cernereFrontendUrl,
    cernereServiceToken: requireEnv('CERNERE_SERVICE_TOKEN'),
    rpId: requireEnv('OSTIARIUS_RP_ID'),
    pwaOrigin: normalizeHttpOrigin('OSTIARIUS_PWA_ORIGIN', requireEnv('OSTIARIUS_PWA_ORIGIN')),
    keyPath: resolve(optionalEnv('OSTIARIUS_KEY_PATH', join(dataDir, 'gateway.key'))),
    // 本番は Infisical / secret-agent が PEM を inject する。 dev は file 経路。
    privateKeyPem: optionalEnv('OSTIARIUS_PRIVATE_KEY', ''),
    // 公開鍵 自己登録 (両方揃って初めて有効、 無ければ手動 provision にフォールバック)。
    aedilisBaseUrl: optionalEnv('AEDILIS_BASE_URL', '').replace(/\/+$/, ''),
    aedilisAdminToken: optionalEnv('AEDILIS_ADMIN_TOKEN', ''),
    label: optionalEnv('OSTIARIUS_LABEL', ''),
    dataDir,
    dbPath: join(dataDir, 'ostiarius.db'),
    // 同期は best-effort、 不通でも前回キャッシュで継続する
    syncIntervalMs: Number(optionalEnv('OSTIARIUS_SYNC_INTERVAL_MS', String(15 * 60 * 1000))),
    challengeTtlMs: Number(optionalEnv('OSTIARIUS_CHALLENGE_TTL_MS', String(2 * 60 * 1000))),
    // Wi-Fi QR は任意機能。 SSID 未設定 = その会場は QR を出さない (エラーにしない)。
    wifiSsid: optionalEnv('OSTIARIUS_WIFI_SSID', ''),
    wifiPassword: optionalEnv('OSTIARIUS_WIFI_PASSWORD', ''),
    // vantan_user プロフィール enrichment も任意機能。 未設定は起動を止めない
    // (createVantanUserClient 側が null を返し、 呼び出し側が enrichment をスキップする)。
    cernereProjectClientId: optionalEnv('OSTIARIUS_CERNERE_PROJECT_CLIENT_ID', ''),
    cernereProjectClientSecret: optionalEnv('OSTIARIUS_CERNERE_PROJECT_CLIENT_SECRET', ''),
    // session/password は passkey より弱い互換経路なので、運用者の明示設定が無ければ公開しない。
    legacyMethods: optionalEnv('OSTIARIUS_LEGACY_METHODS', '')
      .split(',')
      .map((method) => method.trim())
      .filter(Boolean),
    kioskToken: requireEnv('OSTIARIUS_KIOSK_TOKEN'),
    templateKey: Buffer.from(requireEnv('OSTIARIUS_TEMPLATE_KEY'), 'base64'),
    faceSidecarUrl: optionalEnv('OSTIARIUS_FACE_SIDECAR_URL', 'http://127.0.0.1:17591').replace(/\/+$/, ''),
    faceMatchThreshold: Number(optionalEnv('OSTIARIUS_FACE_MATCH_THRESHOLD', '0.62')),
    faceMargin: Number(optionalEnv('OSTIARIUS_FACE_MARGIN', '0.08')),
    livenessThreshold: Number(optionalEnv('OSTIARIUS_LIVENESS_THRESHOLD', '0.90')),
    faceChallengeRequired: optionalEnv('OSTIARIUS_FACE_CHALLENGE', 'required') === 'required',
    faceTemplateSource: optionalEnv('OSTIARIUS_FACE_TEMPLATE_SOURCE', 'cernere') === 'local' ? 'local' : 'cernere',
    aedilisGatewayToken: optionalEnv('AEDILIS_GATEWAY_TOKEN', ''),
    staffRoles: optionalEnv('OSTIARIUS_STAFF_ROLES', 'staff,admin').split(',').map((role) => role.trim()).filter(Boolean),
    eventRetentionDays: Number(optionalEnv('OSTIARIUS_EVENT_RETENTION_DAYS', '90')),
    dailyOverrideLimit: Number(optionalEnv('OSTIARIUS_STAFF_OVERRIDE_DAILY_LIMIT', '20')),
  };
}
