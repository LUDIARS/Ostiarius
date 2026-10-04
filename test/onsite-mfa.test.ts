import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { Hono } from 'hono';

import { b64urlDecode, signAttestation, verifyAttestation } from '../server/attestation.ts';
import { ChallengeStore } from '../server/challenge-store.ts';
import { openDb, upsertCredential } from '../server/db.ts';
import { createLanGuard } from '../server/face/lan-guard.ts';
import type { FaceFrameResult, FaceVerificationFlow } from '../server/face/verification-flow.ts';
import { KioskAuthorization } from '../server/kiosk-authorization.ts';
import { onsiteMfaSubmitter, submitOnsiteMfaAttestation } from '../server/onsite-mfa/cernere-submit.ts';
import { OnsiteMfaSessionStore } from '../server/onsite-mfa/session-store.ts';
import { PasskeyCheckinService } from '../server/passkey-checkin.ts';
import { makeOnsiteMfaRouter } from '../server/routes/onsite-mfa.ts';
import { makeOnsiteMfaKioskRouter } from '../server/routes/onsite-mfa-kiosk.ts';
import { createSoftAuthenticator } from './webauthn-soft-authenticator.ts';

const KIOSK_HEADERS = { 'x-ostiarius-kiosk': 'kiosk-token' };
// kiosk token は TLS 接続のときだけ受ける (app.request() は URL の scheme を TLS の有無として読む)。
const KIOSK_TLS = 'https://ostiarius.test';
const CERNERE_ORIGIN = 'https://cernere.example.test';
const CERNERE_BASE = 'https://cernere-api.example.test';
const RP_ID = 'localhost';
const PWA_ORIGIN = 'http://localhost:5173';
const TTL_MS = 5 * 60_000;

interface CernereCall { url: string; headers: Record<string, string>; body: string }

function nonce(): string {
  return randomBytes(32).toString('base64url');
}

function cernereResponse(status: number, body: unknown) {
  const calls: CernereCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: String(init?.body) });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function stubFlow(result: FaceFrameResult | null): FaceVerificationFlow {
  return { process: async () => result } as unknown as FaceVerificationFlow;
}

const ISSUED_FACE: FaceFrameResult = {
  state: 'issued', hint: null, challenge: null,
  result: { subjectHint: 'ID / 42', assurance: 'high' },
  subjectUserId: 'user-42',
};

function setup(options: { lan?: boolean; cernere?: { status: number; body: unknown }; flow?: FaceVerificationFlow } = {}) {
  let clock = 1_800_000_000_000;
  const keyPair = generateKeyPairSync('ed25519');
  const db = openDb(':memory:');
  const challenges = new ChallengeStore(120_000);
  const sessions = new OnsiteMfaSessionStore({ now: () => clock });
  const cernere = cernereResponse(options.cernere?.status ?? 200, options.cernere?.body ?? { accepted: true });
  const app = new Hono();
  app.route('/', makeOnsiteMfaRouter({ sessions, isLan: () => options.lan ?? true, corsOrigin: CERNERE_ORIGIN }));
  app.route('/', makeOnsiteMfaKioskRouter({
    authorization: new KioskAuthorization('kiosk-token'),
    flow: options.flow ?? stubFlow(ISSUED_FACE),
    passkey: new PasskeyCheckinService({ db, challenges, lanId: 'lan-1', facilityId: 'room-1', rpId: RP_ID, pwaOrigin: PWA_ORIGIN, privateKey: keyPair.privateKey }),
    completion: {
      sessions,
      privateKey: keyPair.privateKey,
      lanId: 'lan-1',
      facilityId: 'room-1',
      submit: onsiteMfaSubmitter({ cernereBaseUrl: CERNERE_BASE, serviceToken: async () => 'svc-token', fetchImpl: cernere.fetchImpl }),
    },
  }));
  return { app, db, keyPair, cernere, advance: (ms: number) => { clock += ms; } };
}

async function start(app: Hono, value = nonce()): Promise<Response> {
  return app.request('/api/mfa/onsite/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: CERNERE_ORIGIN },
    body: JSON.stringify({ nonce: value }),
  });
}

async function state(app: Hono, sessionId: string): Promise<unknown> {
  return (await app.request(`/api/mfa/onsite/sessions/${sessionId}`)).json();
}

async function sendFaceFrame(app: Hono, sessionId: string): Promise<Response> {
  const form = new FormData();
  form.set('identitySessionId', 'identity-1');
  form.set('frame', new File([new Uint8Array([1, 2, 3])], 'frame.jpg', { type: 'image/jpeg' }));
  return app.request(`${KIOSK_TLS}/kiosk/mfa/${sessionId}/face/frame`, { method: 'POST', headers: KIOSK_HEADERS, body: form });
}

describe('onsite MFA session API (contract E)', () => {
  it('rejects a start request from outside the venue LAN', async () => {
    const { app } = setup({ lan: false });
    const response = await start(app);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'lan_required' });
  });

  it('treats a relayed request as outside the LAN even from a private address', async () => {
    const isLan = createLanGuard(() => '192.168.10.5');
    const app = new Hono();
    app.route('/', makeOnsiteMfaRouter({ sessions: new OnsiteMfaSessionStore(), isLan, corsOrigin: CERNERE_ORIGIN }));
    const relayed = await app.request('/api/mfa/onsite/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
      body: JSON.stringify({ nonce: nonce() }),
    });
    expect(relayed.status).toBe(403);
    expect((await start(app)).status).toBe(202);
  });

  it('accepts only a 32-byte base64url nonce', async () => {
    const { app } = setup();
    expect((await start(app, 'short')).status).toBe(400);
    expect((await start(app, `${nonce().slice(0, 42)}=`)).status).toBe(400);
  });

  it('opens one waiting session per kiosk and answers kiosk_busy to a second one', async () => {
    const { app } = setup();
    const first = await start(app);
    expect(first.status).toBe(202);
    const opened = await first.json() as { sessionId: string; expiresAt: number };
    expect(opened.expiresAt).toBe(1_800_000_000_000 + TTL_MS);
    expect(await state(app, opened.sessionId)).toEqual({ state: 'waiting' });

    const second = await start(app);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'kiosk_busy' });
  });

  it('expires a session after 5 minutes and frees the kiosk', async () => {
    const { app, advance, cernere } = setup();
    const opened = await (await start(app)).json() as { sessionId: string };
    advance(TTL_MS);
    expect(await state(app, opened.sessionId)).toEqual({ state: 'expired' });
    // 期限切れのセッションへは本人確定後も送らない。
    const late = await sendFaceFrame(app, opened.sessionId);
    expect(late.status).toBe(409);
    expect(cernere.calls).toHaveLength(0);
    expect((await start(app)).status).toBe(202);
  });

  it('allows CORS only for the Cernere public origin, including the private network preflight', async () => {
    const { app } = setup();
    const preflight = await app.request('/api/mfa/onsite/sessions', {
      method: 'OPTIONS',
      headers: { origin: CERNERE_ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBe(CERNERE_ORIGIN);
    expect(preflight.headers.get('access-control-allow-private-network')).toBe('true');
    const foreign = await app.request('/api/mfa/onsite/sessions', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects a replayed start request carrying an already used nonce', async () => {
    const { app, advance } = setup();
    const value = nonce();
    expect((await start(app, value)).status).toBe(202);
    // 先のセッションが期限切れで kiosk が空いていても、同じ nonce では開けない。
    advance(TTL_MS + 1);
    const replay = await start(app, value);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ error: 'nonce_reused' });
    expect((await start(app)).status).toBe(202);
  });

  it('requires kiosk authorization for the kiosk-side endpoints', async () => {
    const { app } = setup();
    expect((await app.request('/kiosk/mfa/current')).status).toBe(401);
  });
});

describe('onsite MFA completion (purpose:"mfa" to Cernere)', () => {
  it('signs purpose:"mfa" after a face match, sends only the attestation to Cernere and marks it submitted', async () => {
    const { app, keyPair, cernere } = setup();
    const value = nonce();
    const opened = await (await start(app, value)).json() as { sessionId: string };
    const current = await (await app.request(`${KIOSK_TLS}/kiosk/mfa/current`, { headers: KIOSK_HEADERS })).json() as { session: Record<string, unknown> };
    expect(current.session).toEqual({ sessionId: opened.sessionId, expiresAt: expect.any(Number) });

    const response = await sendFaceFrame(app, opened.sessionId);
    const body = await response.json() as Record<string, unknown>;
    expect(body.mfa).toEqual({ state: 'submitted' });
    expect(body).not.toHaveProperty('subjectUserId');
    expect(await state(app, opened.sessionId)).toEqual({ state: 'submitted' });

    expect(cernere.calls).toHaveLength(1);
    const call = cernere.calls[0]!;
    expect(call.url).toBe(`${CERNERE_BASE}/api/mfa/onsite/attestations`);
    expect(call.headers.authorization).toBe('Bearer svc-token');
    const sent = JSON.parse(call.body) as Record<string, unknown>;
    // 顔画像・テンプレート・スコアは送らない。body は attestation だけ。
    expect(Object.keys(sent)).toEqual(['attestation']);
    const verified = verifyAttestation(sent.attestation as string, keyPair.publicKey);
    expect(verified.ok).toBe(true);
    expect(verified.payload).toEqual({
      sub: 'user-42', placeId: 'room-1', lanId: 'lan-1', nonce: value,
      issuedAt: 1_800_000_000_000, method: 'face', assurance: 'high', purpose: 'mfa',
    });
    const payloadKeys = Object.keys(JSON.parse(b64urlDecode((sent.attestation as string).split('.')[0]!).toString('utf8')) as object);
    expect(payloadKeys).toEqual(['sub', 'placeId', 'lanId', 'nonce', 'issuedAt', 'method', 'assurance', 'purpose']);
    // 送信済みのセッションへは二度送らない。
    expect((await sendFaceFrame(app, opened.sessionId)).status).toBe(409);
    expect(cernere.calls).toHaveLength(1);
  });

  it('reflects a Cernere rejection code in the state API and frees the kiosk', async () => {
    const { app } = setup({ cernere: { status: 409, body: { error: 'subject_mismatch' } } });
    const opened = await (await start(app)).json() as { sessionId: string };
    const body = await (await sendFaceFrame(app, opened.sessionId)).json() as Record<string, unknown>;
    expect(body.mfa).toEqual({ state: 'rejected', error: 'subject_mismatch' });
    expect(await state(app, opened.sessionId)).toEqual({ state: 'rejected', error: 'subject_mismatch' });
    expect((await start(app)).status).toBe(202);
  });

  it('keeps waiting while the face flow has not identified anyone', async () => {
    const scanning: FaceFrameResult = { state: 'scanning', hint: 'no_match', challenge: null, result: null };
    const { app, cernere } = setup({ flow: stubFlow(scanning) });
    const opened = await (await start(app)).json() as { sessionId: string };
    expect(await (await sendFaceFrame(app, opened.sessionId)).json()).toEqual(scanning);
    expect(await state(app, opened.sessionId)).toEqual({ state: 'waiting' });
    expect(cernere.calls).toHaveLength(0);
  });

  it('confirms with a kiosk passkey as medium assurance without sending attendance', async () => {
    const { app, db, keyPair, cernere } = setup();
    const authenticator = createSoftAuthenticator({ userHandle: 'user-7' });
    upsertCredential(db, { userId: 'user-7', credentialId: authenticator.credentialId, publicKey: authenticator.publicKeyCoseBase64, counter: 0, transports: ['internal'] });
    const opened = await (await start(app)).json() as { sessionId: string };

    const begin = await app.request(`${KIOSK_TLS}/kiosk/mfa/${opened.sessionId}/passkey/begin`, { method: 'POST', headers: KIOSK_HEADERS });
    expect(begin.status).toBe(200);
    const options = await begin.json() as { challenge: string };
    const finish = await app.request(`${KIOSK_TLS}/kiosk/mfa/${opened.sessionId}/passkey/finish`, {
      method: 'POST',
      headers: { ...KIOSK_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ response: authenticator.buildAssertion(options.challenge, PWA_ORIGIN, RP_ID) }),
    });
    expect(await finish.json()).toEqual({ mfa: { state: 'submitted' } });
    // 送信先は Cernere だけ (Aedilis へ出席を送らない)。
    expect(cernere.calls.map((call) => call.url)).toEqual([`${CERNERE_BASE}/api/mfa/onsite/attestations`]);
    const sent = JSON.parse(cernere.calls[0]!.body) as { attestation: string };
    expect(verifyAttestation(sent.attestation, keyPair.publicKey).payload).toMatchObject({ sub: 'user-7', method: 'passkey', assurance: 'medium', purpose: 'mfa' });
  });
});

describe('submitOnsiteMfaAttestation', () => {
  const signed = signAttestation({
    sub: 'user-1', placeId: 'room-1', lanId: 'lan-1', nonce: nonce(), issuedAt: 1,
    method: 'face', assurance: 'high', purpose: 'mfa',
  }, generateKeyPairSync('ed25519').privateKey);
  const options = (status: number, body: unknown) => ({ cernereBaseUrl: CERNERE_BASE, serviceToken: async () => 'svc-token', fetchImpl: cernereResponse(status, body).fetchImpl });

  it('maps responses to accepted, the fixed vocabulary or a local failure code', async () => {
    await expect(submitOnsiteMfaAttestation(options(200, { accepted: true }), signed)).resolves.toEqual({ status: 'accepted' });
    await expect(submitOnsiteMfaAttestation(options(400, { error: 'stale' }), signed)).resolves.toEqual({ status: 'rejected', error: 'stale' });
    await expect(submitOnsiteMfaAttestation(options(403, { error: 'insufficient_scope' }), signed)).resolves.toEqual({ status: 'rejected', error: 'submit_unauthorized' });
    await expect(submitOnsiteMfaAttestation(options(500, { error: 'boom' }), signed)).resolves.toEqual({ status: 'rejected', error: 'submit_failed' });
    await expect(submitOnsiteMfaAttestation(options(200, { accepted: false }), signed)).resolves.toEqual({ status: 'rejected', error: 'submit_failed' });
  });

  it('reports token and network failures without throwing', async () => {
    await expect(submitOnsiteMfaAttestation({ cernereBaseUrl: CERNERE_BASE, serviceToken: async () => { throw new Error('login failed'); } }, signed))
      .resolves.toEqual({ status: 'rejected', error: 'service_token_unavailable' });
    const unreachable = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    await expect(submitOnsiteMfaAttestation({ cernereBaseUrl: CERNERE_BASE, serviceToken: async () => 't', fetchImpl: unreachable }, signed))
      .resolves.toEqual({ status: 'rejected', error: 'cernere_unreachable' });
  });
});
