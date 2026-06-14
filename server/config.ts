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

export interface OstiariusConfig {
  port: number;
  lanId: string;
  facilityId: string;
  cernereBaseUrl: string;
  cernereServiceToken: string;
  rpId: string;
  pwaOrigin: string;
  keyPath: string;
  dataDir: string;
  dbPath: string;
  syncIntervalMs: number;
  challengeTtlMs: number;
}

export function loadConfig(): OstiariusConfig {
  const dataDir = resolve(optionalEnv('OSTIARIUS_DATA', join(__dirname, '..', 'data')));
  return {
    port: Number(optionalEnv('OSTIARIUS_PORT', '17590')),
    lanId: requireEnv('OSTIARIUS_LAN_ID'),
    facilityId: requireEnv('OSTIARIUS_FACILITY_ID'),
    cernereBaseUrl: requireEnv('CERNERE_BASE_URL').replace(/\/+$/, ''),
    cernereServiceToken: requireEnv('CERNERE_SERVICE_TOKEN'),
    rpId: requireEnv('OSTIARIUS_RP_ID'),
    pwaOrigin: requireEnv('OSTIARIUS_PWA_ORIGIN'),
    keyPath: resolve(optionalEnv('OSTIARIUS_KEY_PATH', join(dataDir, 'gateway.key'))),
    dataDir,
    dbPath: join(dataDir, 'ostiarius.db'),
    // 同期は best-effort、 不通でも前回キャッシュで継続する
    syncIntervalMs: Number(optionalEnv('OSTIARIUS_SYNC_INTERVAL_MS', String(15 * 60 * 1000))),
    challengeTtlMs: Number(optionalEnv('OSTIARIUS_CHALLENGE_TTL_MS', String(2 * 60 * 1000))),
  };
}
