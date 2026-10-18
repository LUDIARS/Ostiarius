import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { Hono } from 'hono';
import { openDb, upsertCredential } from '../server/db.ts';
import { ChallengeStore } from '../server/challenge-store.ts';
import { IdentitySessionStore } from '../server/identity-session-store.ts';
import { KioskAuthorization } from '../server/kiosk-authorization.ts';
import { makeKioskProximityRouter } from '../server/routes/kiosk-proximity.ts';
import { makeIdentityRouter } from '../server/routes/identity.ts';
import { proximityOriginAllowed } from '../server/proximity-capability.ts';
import { createSoftAuthenticator } from './webauthn-soft-authenticator.ts';
import type { AttendanceSender } from '../server/attendance-delivery.ts';
import { isRateLimitedRoute, isSensitiveRoute } from '../server/http-security/lan-routes.ts';

const ORIGIN = 'https://kiosk.example.test';
const RP = 'example.test';
const headers = { origin: ORIGIN, 'content-type': 'application/json', 'x-ostiarius-kiosk': 'test-token' };
const databases: ReturnType<typeof openDb>[] = [];
afterEach(() => { vi.useRealTimers(); for (const db of databases.splice(0)) db.close(); });

function setup(sender: AttendanceSender = async () => ({ status: 'recorded', attendanceId: 'test-attendance', matchedReservation: null })) {
  const db = openDb(':memory:'); databases.push(db);
  const sessions = new IdentitySessionStore();
  const authorization = new KioskAuthorization('test-token');
  const authenticator = createSoftAuthenticator({ userHandle: 'student-1' });
  upsertCredential(db, { userId: 'student-1', credentialId: authenticator.credentialId,
    publicKey: authenticator.publicKeyCoseBase64, counter: 0, transports: ['internal'] });
  const send = vi.fn(sender);
  const deps = { db, sessions, authorization, challenges: new ChallengeStore(120_000),
    lanId: 'lan', facilityId: 'facility', rpId: RP, pwaOrigin: ORIGIN,
    privateKey: generateKeyPairSync('ed25519').privateKey, sendAttendance: send };
  const app = new Hono().route('/', makeKioskProximityRouter(deps));
  app.route('/', makeIdentityRouter({ ...deps, kioskAuthorization: authorization, cernereFrontendUrl: 'https://cr.example.test' }));
  const post = (id: string, action: string, body: unknown = {}, extraHeaders = headers) => app.request(ORIGIN + '/kiosk/proximity/' + id + '/' + action,
    { method: 'POST', headers: extraHeaders, body: JSON.stringify(body) });
  const begin = async (id = sessions.create().sessionId) => {
    const response = await post(id, 'begin');
    expect(response.status).toBe(200);
    return { id, options: await response.json() as { challenge: string; hints: string[]; allowCredentials: { transports: string[] }[]; userVerification: string } };
  };
  return { db, app, sessions, authenticator, send, post, begin };
}

describe('Kiosk proximity attendance', () => {
  it('requests hybrid transport with user verification even for synced internal credentials', async () => {
    const { begin } = setup(); const { options } = await begin();
    expect(options.hints).toEqual(['hybrid']);
    expect(options.allowCredentials[0]?.transports).toEqual(['hybrid']);
    expect(options.userVerification).toBe('required');
  });
  it('verifies a signed assertion, records attendance once, and closes the session', async () => {
    const f = setup(); const { id, options } = await f.begin();
    const response = f.authenticator.buildAssertion(options.challenge, ORIGIN, RP);
    expect((await f.post(id, 'finish', { response })).status).toBe(200);
    expect(f.sessions.get(id)?.state).toBe('issued');
    expect((await f.post(id, 'finish', { response })).status).toBe(410);
    expect(f.send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(Buffer.from(f.send.mock.calls[0]![0].split('.')[0]!, 'base64url').toString('utf8'));
    expect(payload).toMatchObject({ purpose: 'attendance', sub: 'student-1', method: 'passkey', assurance: 'medium' });
    const event = f.db.prepare('SELECT method, subject_user FROM verification_events').get();
    expect(event).toEqual({ method: 'passkey', subject_user: 'student-1' });
  });
  it('requires kiosk authorization and same-origin JSON mutations', async () => {
    const f = setup(); const id = f.sessions.create().sessionId;
    expect((await f.post(id, 'begin', {}, { ...headers, 'x-ostiarius-kiosk': '' })).status).toBe(401);
    expect((await f.post(id, 'begin', {}, { ...headers, origin: 'https://evil.test' })).status).toBe(403);
    expect((await f.post(id, 'begin', {}, { ...headers, 'content-type': 'text/plain' })).status).toBe(403);
    expect(f.send).not.toHaveBeenCalled();
  });
  it('rejects malformed assertions without recording anything', async () => {
    const f = setup(); const { id } = await f.begin();
    expect((await f.post(id, 'finish', { response: { id: 'broken' } })).status).toBe(401);
    expect(f.send).not.toHaveBeenCalled();
  });
  it('rejects wrong origin, unknown credential and expired sessions', async () => {
    const f = setup(); let started = await f.begin();
    expect((await f.post(started.id, 'finish', { response: f.authenticator.buildAssertion(started.options.challenge, 'https://evil.test', RP) })).status).toBe(401);
    started = await f.begin();
    expect((await f.post(started.id, 'finish', { response: createSoftAuthenticator().buildAssertion(started.options.challenge, ORIGIN, RP) })).status).toBe(401);
    vi.useFakeTimers(); started = await f.begin(); vi.advanceTimersByTime(60_001);
    expect((await f.post(started.id, 'finish', { response: f.authenticator.buildAssertion(started.options.challenge, ORIGIN, RP) })).status).toBe(410);
    expect(f.send).not.toHaveBeenCalled();
  });
  it('does not accept a challenge in a different kiosk session', async () => {
    const f = setup(); const { options } = await f.begin(); const other = f.sessions.create().sessionId;
    expect((await f.post(other, 'finish', { response: f.authenticator.buildAssertion(options.challenge, ORIGIN, RP) })).status).toBe(400);
    expect(f.send).not.toHaveBeenCalled();
  });
  it('does not reuse a public attendance challenge in the proximity flow', async () => {
    const f = setup(); const id = f.sessions.create().sessionId;
    const response = await f.app.request(ORIGIN + '/identity/passkey/begin', { method: 'POST', headers, body: JSON.stringify({ sessionId: id }) });
    const options = await response.json() as { challenge: string };
    expect((await f.post(id, 'finish', { response: f.authenticator.buildAssertion(options.challenge, ORIGIN, RP) })).status).toBe(400);
    expect(f.send).not.toHaveBeenCalled();
  });
  it('never marks a failed attendance delivery as successful', async () => {
    const f = setup(async () => ({ status: 'failed', code: 'test_failure' }));
    const { id, options } = await f.begin();
    const response = f.authenticator.buildAssertion(options.challenge, ORIGIN, RP);
    expect((await f.post(id, 'finish', { response })).status).toBe(502);
    expect(f.sessions.get(id)?.state).not.toBe('issued');
    expect((await f.post(id, 'finish', { response })).status).toBe(400);
  });
  it('serializes submissions while delivery is pending', async () => {
    let release!: () => void;
    const delivered = new Promise<void>(resolve => { release = resolve; });
    const f = setup(async () => { await delivered; return { status: 'recorded', attendanceId: 'test', matchedReservation: null }; });
    const { id, options } = await f.begin();
    const response = f.authenticator.buildAssertion(options.challenge, ORIGIN, RP);
    const first = f.post(id, 'finish', { response });
    try {
      await vi.waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
      expect((await f.post(id, 'finish', { response })).status).toBe(409);
    } finally { release(); }
    expect((await first).status).toBe(200);
  });
  it('reports FeliCa unavailable rather than accepting an ID as authentication', async () => {
    const f = setup(); const response = await f.app.request(ORIGIN + '/kiosk/proximity/capabilities', { headers });
    expect(await response.json()).toEqual({ passkey: true, felica: false });
  });
});

describe('proximity deployment boundary', () => {
  it('includes begin and finish in LAN protection and rate limits', async () => {
    const app = new Hono();
    app.post('/kiosk/proximity/:id/:action', c => c.json({ sensitive: isSensitiveRoute(c), limited: isRateLimitedRoute(c) }));
    for (const action of ['begin', 'finish']) {
      const result = await app.request('/kiosk/proximity/session/' + action, { method: 'POST' });
      expect(await result.json()).toEqual({ sensitive: true, limited: true });
    }
  });
  it('requires the configured origin, secure context, and compatible RP ID', () => {
    expect(proximityOriginAllowed(ORIGIN, ORIGIN, RP)).toBe(true);
    expect(proximityOriginAllowed('http://localhost:17590', ORIGIN, RP)).toBe(false);
    expect(proximityOriginAllowed('http://kiosk.example.test', 'http://kiosk.example.test', RP)).toBe(false);
    expect(proximityOriginAllowed(ORIGIN, ORIGIN, 'evil.test')).toBe(false);
    expect(proximityOriginAllowed('http://localhost:17590', 'http://localhost:17590', 'localhost')).toBe(true);
  });
});
