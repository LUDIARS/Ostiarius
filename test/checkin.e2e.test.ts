// Ostiarius チェックイン E2E (生体タップ → attestation 発行レッグ)。
//
// 実機・別PC・LAN なしで、 Ostiarius の本体フロー
//   POST /checkin/begin  → (ソフト authenticator で UV 付き assertion 署名) →
//   POST /checkin/finish → Ed25519 attestation 発行
// を in-process (Hono app.request) で通しで検証する。 「生体タップ」は
// test/webauthn-soft-authenticator.ts のソフト authenticator で代替する。
//
// Cernere 同期は対象外 (= Ostiarius の credentials テーブルへ直接 upsert して
// 「同期済み」状態を再現)。 同期そのものは cernere-sync 側の関心事。
// 発行された attestation は Aedilis と同一の Ed25519/SPKI 契約 (CONTRACTS §1) で
// 検証できることまで確認する (= 跨りサービスの検証境界)。

import { beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { Hono } from 'hono';

import { openDb, upsertCredential } from '../server/db.ts';
import { ChallengeStore } from '../server/challenge-store.ts';
import { makeCheckinRouter } from '../server/routes/checkin.ts';
import { verifyAttestation } from '../server/attestation.ts';
import { createSoftAuthenticator, type SoftAuthenticator } from './webauthn-soft-authenticator.ts';

const LAN_ID = 'lan-test-1';
const FACILITY = 'room-101';
const RP_ID = 'localhost';
const PWA_ORIGIN = 'http://localhost:5173';
const USER = 'user-alice';

let app: Hono;
let gatewayPublicKey: KeyObject;
let gatewayPublicKeyPem: string;
let authn: SoftAuthenticator;
// challenge を 2 度目に使えないか (replay) を見るため、 TTL は十分長く取る。
let challenges: ChallengeStore;
let db: ReturnType<typeof openDb>;

function freshRouter(): Hono {
  const pair = generateKeyPairSync('ed25519');
  gatewayPublicKey = pair.publicKey;
  gatewayPublicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  challenges = new ChallengeStore(2 * 60 * 1000);
  return makeCheckinRouter({
    db,
    challenges,
    lanId: LAN_ID,
    facilityId: FACILITY,
    rpId: RP_ID,
    pwaOrigin: PWA_ORIGIN,
    privateKey: pair.privateKey,
    publicKeyPem: gatewayPublicKeyPem,
  });
}

/** Cernere 同期で credential が入った状態を再現する。 */
function syncCredential(a: SoftAuthenticator, userId = USER): void {
  upsertCredential(db, {
    userId,
    credentialId: a.credentialId,
    publicKey: a.publicKeyCoseBase64,
    counter: 0,
    transports: ['internal'],
  });
}

async function begin(): Promise<{ status: number; body: any }> {
  const res = await app.request('/checkin/begin', { method: 'POST' });
  return { status: res.status, body: await res.json() };
}

async function finish(response: unknown): Promise<{ status: number; body: any }> {
  const res = await app.request('/checkin/finish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ response }),
  });
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  db = openDb(':memory:');
  authn = createSoftAuthenticator({ userHandle: USER });
  app = freshRouter();
});

describe('Ostiarius check-in E2E (software authenticator = 生体タップ代替)', () => {
  it('begin → assertion 署名 → finish で attestation を発行し、 ゲートウェイ公開鍵で検証できる', async () => {
    syncCredential(authn);

    const b = await begin();
    expect(b.status).toBe(200);
    expect(typeof b.body.challenge).toBe('string');
    expect(b.body.allowCredentials?.[0]?.id).toBe(authn.credentialId);

    const assertion = authn.buildAssertion(b.body.challenge, PWA_ORIGIN, RP_ID);
    const f = await finish(assertion);
    expect(f.status).toBe(200);
    expect(f.body.ok).toBe(true);
    expect(typeof f.body.attestation).toBe('string');

    // 跨りサービスの検証境界: Aedilis と同じ Ed25519/SPKI 契約で検証できる。
    const v = verifyAttestation(f.body.attestation, gatewayPublicKey);
    expect(v.ok).toBe(true);
    expect(v.payload?.sub).toBe(USER);
    expect(v.payload?.lanId).toBe(LAN_ID);
    expect(v.payload?.placeId).toBe(FACILITY);
    expect(v.payload?.nonce).toBe(b.body.challenge);
    expect(v.payload?.issuedAt).toBeGreaterThan(0);
  });

  it('credential 未同期だと begin が 409 を返す', async () => {
    const b = await begin();
    expect(b.status).toBe(409);
    expect(b.body.error).toBe('no_credentials');
  });

  it('未登録 credential の assertion は 401 (unknown_credential)', async () => {
    syncCredential(authn);
    const b = await begin();
    // 別の (同期されていない) authenticator で署名する。
    const stranger = createSoftAuthenticator();
    const assertion = stranger.buildAssertion(b.body.challenge, PWA_ORIGIN, RP_ID);
    const f = await finish(assertion);
    expect(f.status).toBe(401);
    expect(f.body.error).toBe('unknown_credential');
  });

  it('同じ challenge を 2 度使うと 2 度目は challenge_expired (replay 防止)', async () => {
    syncCredential(authn);
    const b = await begin();
    const assertion = authn.buildAssertion(b.body.challenge, PWA_ORIGIN, RP_ID);

    const first = await finish(assertion);
    expect(first.status).toBe(200);

    // 同じ assertion (= 同じ challenge) を再投入 → consume 済みで弾かれる。
    const second = await finish(assertion);
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('challenge_expired');
  });

  it('begin で発行していない challenge の assertion は challenge_expired', async () => {
    syncCredential(authn);
    const assertion = authn.buildAssertion('not-a-real-challenge', PWA_ORIGIN, RP_ID);
    const f = await finish(assertion);
    expect(f.status).toBe(400);
    expect(f.body.error).toBe('challenge_expired');
  });

  it('署名を改竄した assertion は 401 (assertion_failed)', async () => {
    syncCredential(authn);
    const b = await begin();
    const assertion = authn.buildAssertion(b.body.challenge, PWA_ORIGIN, RP_ID);
    // 署名末尾を 1 文字差し替えて壊す。
    const sig = assertion.response.signature;
    assertion.response.signature = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
    const f = await finish(assertion);
    expect(f.status).toBe(401);
    expect(f.body.error).toBe('assertion_failed');
  });

  it('origin / rpId が期待値と違う assertion は 401 (assertion_failed)', async () => {
    syncCredential(authn);
    const b = await begin();
    const assertion = authn.buildAssertion(b.body.challenge, 'http://evil.example', RP_ID);
    const f = await finish(assertion);
    expect(f.status).toBe(401);
    expect(f.body.error).toBe('assertion_failed');
  });

  it('GET /gateway-public-key で lanId / facilityId / 公開鍵 PEM を返す', async () => {
    const res = await app.request('/gateway-public-key');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lanId: string; facilityId: string; publicKeyPem: string };
    expect(body.lanId).toBe(LAN_ID);
    expect(body.facilityId).toBe(FACILITY);
    expect(body.publicKeyPem).toBe(gatewayPublicKeyPem);
  });
});
