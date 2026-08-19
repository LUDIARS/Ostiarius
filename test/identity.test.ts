import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { Hono } from 'hono';

import { openDb, upsertCredential } from '../server/db.ts';
import { ChallengeStore } from '../server/challenge-store.ts';
import { IdentitySessionStore } from '../server/identity-session-store.ts';
import { KioskAuthorization } from '../server/kiosk-authorization.ts';
import { makeIdentityRouter } from '../server/routes/identity.ts';
import { makeKioskRouter } from '../server/routes/kiosk.ts';
import { createSoftAuthenticator } from './webauthn-soft-authenticator.ts';

const KIOSK_TOKEN = 'test-kiosk-token';
const KIOSK_HEADERS = { 'x-ostiarius-kiosk': KIOSK_TOKEN };
const RP_ID = 'localhost';
const PWA_ORIGIN = 'http://localhost:5173';

function app() {
  const keyPair = generateKeyPairSync('ed25519');
  const db = openDb(':memory:');
  const sessions = new IdentitySessionStore();
  const authorization = new KioskAuthorization(KIOSK_TOKEN);
  const router = new Hono();
  router.route('/', makeIdentityRouter({
    db,
    challenges: new ChallengeStore(120_000),
    lanId: 'lan',
    facilityId: 'room',
    rpId: RP_ID,
    pwaOrigin: PWA_ORIGIN,
    privateKey: keyPair.privateKey,
    cernereFrontendUrl: 'https://cernere.example.test',
    kioskAuthorization: authorization,
    sessions,
  }));
  router.route('/', makeKioskRouter({ authorization, pwaOrigin: PWA_ORIGIN, sessions, reviewEnabled: false }));
  return { router, db };
}

async function createSession(router: Hono): Promise<{ sessionId: string; expiresAt: number }> {
  const response = await router.request('/identity/session', {
    method: 'POST',
    headers: { ...KIOSK_HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({ purpose: 'verify' }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ sessionId: string; expiresAt: number }>;
}

describe('/identity P1 kiosk support', () => {
  it('requires kiosk authorization for session state and registration hints', async () => {
    const { router } = app();
    const create = await router.request('/identity/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'verify' }),
    });
    const registerHint = await router.request('/identity/passkey/register-hint');

    expect(create.status).toBe(401);
    expect(registerHint.status).toBe(401);
  });

  it('creates a 60-second session and exposes its idle state to the kiosk', async () => {
    const { router } = app();
    const body = await createSession(router);
    expect(body.expiresAt).toBeGreaterThan(Date.now());

    const get = await router.request(`/identity/session/${body.sessionId}`, { headers: KIOSK_HEADERS });
    expect(await get.json()).toEqual({ state: 'idle' });
  });

  it('binds a public passkey assertion to the kiosk session and records the issued event', async () => {
    const { router, db } = app();
    const session = await createSession(router);
    const authenticator = createSoftAuthenticator({ userHandle: 'user-42' });
    upsertCredential(db, {
      userId: 'user-42',
      credentialId: authenticator.credentialId,
      publicKey: authenticator.publicKeyCoseBase64,
      counter: 0,
      transports: ['internal'],
    });

    const begin = await router.request('/identity/passkey/begin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.sessionId }),
    });
    expect(begin.status).toBe(200);
    const options = await begin.json() as { challenge: string };
    const assertion = authenticator.buildAssertion(options.challenge, PWA_ORIGIN, RP_ID);
    const finish = await router.request('/identity/passkey/finish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response: assertion }),
    });
    expect(finish.status).toBe(200);

    const state = await router.request(`/identity/session/${session.sessionId}`, { headers: KIOSK_HEADERS });
    expect(await state.json()).toEqual({ state: 'issued', method: 'passkey' });
    const event = db.prepare(
      'SELECT method, outcome, subject_user, session_id FROM verification_events',
    ).get() as Record<string, unknown>;
    expect(event).toEqual({
      method: 'passkey',
      outcome: 'issued',
      subject_user: 'user-42',
      session_id: session.sessionId,
    });
  });

  it('rejects an expired or unknown session instead of silently detaching it', async () => {
    const { router } = app();
    const response = await router.request('/identity/passkey/begin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'missing-session' }),
    });
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: 'session_expired' });
  });

  it('returns a local Cernere registration QR without making a Cernere request', async () => {
    const response = await app().router.request('/identity/passkey/register-hint', {
      headers: KIOSK_HEADERS,
    });
    const body = await response.json() as { registerUrl: string; qrSvg: string };
    expect(body.registerUrl).toBe('https://cernere.example.test/profile#passkey');
    expect(body.qrSvg).toContain('<svg');
  });

  it('exchanges the kiosk header for an HttpOnly cookie without embedding the token in HTML', async () => {
    const { router } = app();
    const bootstrap = await router.request('http://ostiarius.test/kiosk', { headers: KIOSK_HEADERS });
    expect(bootstrap.status).toBe(200);
    const cookie = bootstrap.headers.get('set-cookie');
    expect(cookie).toContain('HttpOnly');

    const page = await router.request('http://ostiarius.test/kiosk', {
      headers: { cookie: cookie?.split(';', 1)[0] ?? '' },
    });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).not.toContain(KIOSK_TOKEN);
    expect(html).not.toContain('?token=');
    expect(page.headers.get('cache-control')).toBe('no-store');
  });

  it('does not accept the shared kiosk credential in a query string', async () => {
    const response = await app().router.request(
      `http://ostiarius.test/kiosk?token=${KIOSK_TOKEN}`,
    );
    expect(response.status).toBe(401);
  });

  it('provides the staff-passkey enrollment flow without exposing the kiosk credential', async () => {
    const response = await app().router.request('http://ostiarius.test/kiosk', {
      headers: KIOSK_HEADERS,
    });
    const html = await response.text();

    expect(html).toContain('顔を登録（職員）');
    expect(html).toContain('/identity/staff/begin');
    expect(html).toContain('/identity/enroll/consent');
    expect(html).toContain('/identity/enroll/frame');
    expect(html).toContain('/identity/enroll/commit');
    expect(html).toContain('shotsRequired = 6');
    expect(html).not.toContain(KIOSK_TOKEN);
  });
});
