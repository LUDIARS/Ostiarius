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
import { openDb, countCredentials } from './db.ts';
import { loadOrCreateKeyPair } from './attestation-key.ts';
import { startCernereSync } from './cernere-sync.ts';
import { registerGatewayKey } from './aedilis-register.ts';
import { ChallengeStore } from './challenge-store.ts';
import { makeCheckinRouter } from './routes/checkin.ts';

const config = loadConfig();
const db = openDb(config.dbPath);
const keyPair = loadOrCreateKeyPair({
  privateKeyPem: config.privateKeyPem,
  keyPath: config.keyPath,
});
const challenges = new ChallengeStore(config.challengeTtlMs);

startCernereSync({
  db,
  cernereBaseUrl: config.cernereBaseUrl,
  serviceToken: config.cernereServiceToken,
  intervalMs: config.syncIntervalMs,
});

const app = new Hono();

// CORS は PWA の origin のみ許可 (CONTRACTS §3: 全 API に CORS)
app.use(
  '*',
  cors({
    origin: config.pwaOrigin,
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['content-type'],
  }),
);

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    service: 'ostiarius',
    lanId: config.lanId,
    facilityId: config.facilityId,
    credentials: countCredentials(db),
  }),
);

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
  provisionGatewayKey();
});
