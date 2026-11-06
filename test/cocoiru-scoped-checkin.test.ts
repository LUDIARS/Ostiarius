/** @implements SPEC-OS-COCOIRU-SCOPED-NATIVE-001 */
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../server/db.ts';
import { ChallengeStore } from '../server/challenge-store.ts';
import { verifyAttestation } from '../server/attestation.ts';
import { makeCocoiruCheckinRouter } from '../server/routes/cocoiru-checkin.ts';
import { createCocoiruLanGuard } from '../server/cocoiru-lan.ts';
import { Hono } from 'hono';
import { isSensitiveRoute, isRateLimitedRoute, requiresRequestNonce } from '../server/http-security/lan-routes.ts';
import { cocoiruAuthority, opaque } from './cocoiru-authority-fixture.ts';
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
async function fixture() {
  const f = cocoiruAuthority(), db = openDb(':memory:'); databases.push(db);
  const keys = generateKeyPairSync('ed25519'), challenges = new ChallengeStore(120_000);
  let lan = true;
  const app = makeCocoiruCheckinRouter({ interfaceName: 'venue', publicOrigin: 'https://os.example', sessions: f.store,
    facilityId: 'configured-facility', lanId: 'configured-lan', privateKey: keys.privateKey, db, challenges, isSameLan: () => lan });
  const created = await f.create();
  const request = (path = '/checkin/cocoiru', body = '{}', signal?: AbortSignal, authorization = 'Bearer ' + created.sessionToken, origin?: string) => {
    const headers = new Headers({ authorization, 'content-type': 'application/json' });
    if (origin !== undefined) headers.set('origin', origin);
    return app.request(new Request('https://os.example' + path, { method: 'POST', body, signal, headers }));
  };
  const audits = () => (db.prepare('SELECT COUNT(*) AS count FROM verification_events').get() as { count: number }).count;
  return { ...f, app, db, keys, request, created, audits, leave: () => { lan = false; } };
}
describe('scoped LAN proof boundary', () => {
  it('issues only the authenticated subject/current venue and existing low-assurance attendance signature', async () => {
    const f = await fixture(), response = await f.request();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const value = await response.json() as { attestation: string };
    expect(Object.keys(value)).toEqual(['attestation']);
    const proof = verifyAttestation(value.attestation, f.keys.publicKey);
    expect(proof.ok).toBe(true);
    expect(proof.payload).toMatchObject({ sub: f.metadata.user.id, placeId: 'configured-facility', lanId: 'configured-lan',
      method: 'session', assurance: 'low', purpose: 'attendance' });
    expect(f.audits()).toBe(1);
    expect(f.call.mock.calls.filter(([action]) => action === 'consume')).toHaveLength(1);
  });
  it('rejects old/global tokens, caller subject/purpose, query changes and wrong origin before permission', async () => {
    const f = await fixture();
    expect((await f.request('/checkin/cocoiru', '{}', undefined, 'Bearer old.global.token')).status).toBe(401);
    for (const body of ['{"userId":"other"}', '{"purpose":"mfa"}', '{"facilityId":"other"}']) expect((await f.request('/checkin/cocoiru', body)).status).toBe(400);
    expect((await f.request('/checkin/cocoiru?user=other')).status).toBe(400);
    expect((await f.request('/checkin/cocoiru', '{}', undefined, undefined, 'https://other.example')).status).toBe(403);
    expect(f.call.mock.calls.map(([action]) => action)).toEqual(['bind']);
    expect(f.audits()).toBe(0);
  });
  it('does not issue or audit after the venue changes while the permit is consumed', async () => {
    const f = await fixture();
    f.control.beforeCall = action => { if (action === 'consume') f.leave(); };
    const response = await f.request();
    expect(response.status).toBe(403);
    expect(f.audits()).toBe(0);
    expect(await response.text()).not.toContain('attestation');
  });
  it('rolls back the audit and discloses no proof when the request ends during its local transaction', async () => {
    const f = await fixture(), controller = new AbortController();
    f.db.function('end_native_owner', () => { controller.abort(); return 1; });
    f.db.exec('CREATE TEMP TRIGGER end_native_owner AFTER INSERT ON verification_events BEGIN SELECT end_native_owner(); END');
    const response = await f.request('/checkin/cocoiru', '{}', controller.signal);
    expect(response.status).toBe(408);
    expect(f.audits()).toBe(0);
    expect(await response.text()).not.toContain('attestation');
  });
  it('accepts only PKCE native exchange and supports final local logout without a cookie', async () => {
    const f = await fixture();
    expect((await f.request('/api/auth/native/exchange', JSON.stringify({ code: opaque() }), undefined, '')).status).toBe(400);
    const response = await f.request('/api/auth/native/exchange', JSON.stringify({ code: opaque(), code_verifier: opaque() }), undefined, '');
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    const created = await response.json() as { sessionToken: string; expiresAt: string };
    expect(Object.keys(created).sort()).toEqual(['expiresAt', 'sessionToken']);
    f.leave();
    expect((await f.request('/api/auth/native/logout')).status).toBe(200);
    expect((await f.request('/checkin/cocoiru')).status).toBe(403);
    f.store.close();
  });
});
describe('actual socket/interface boundary', () => {
  it('keeps native credentials under transport hardening and rate-limits exchange without ambient nonce authentication', async () => {
    const app = new Hono();
    app.post('*', c => c.json({ sensitive: isSensitiveRoute(c), limited: isRateLimitedRoute(c), nonce: requiresRequestNonce(c) }));
    expect(await (await app.request('https://os.example/api/auth/native/exchange', { method: 'POST' })).json()).toEqual({ sensitive: true, limited: true, nonce: false });
    expect(await (await app.request('https://os.example/api/auth/native/logout', { method: 'POST' })).json()).toEqual({ sensitive: true, limited: false, nonce: false });
  });
  it('accepts only the selected current subnet and refuses proxy, loopback, missing socket or another interface', async () => {
    let present = true;
    const guard = createCocoiruLanGuard('venue', () => present ? { venue: [{ address: '10.10.0.2', netmask: '255.255.255.0',
      family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: '10.10.0.2/24' }] } : {});
    const app = new Hono(); app.post('/', c => c.json({ allowed: guard(c) }));
    const check = async (remoteAddress?: string, localAddress = '10.10.0.2', headers: Record<string, string> = {}) => {
      const env = remoteAddress ? { incoming: { socket: { remoteAddress, localAddress } } } : {};
      return (await app.request('https://os.example/', { method: 'POST', headers }, env)).json();
    };
    expect(await check('10.10.0.20')).toEqual({ allowed: true });
    expect(await check('10.11.0.20')).toEqual({ allowed: false });
    expect(await check('127.0.0.1', '127.0.0.1')).toEqual({ allowed: false });
    expect(await check('10.10.0.20', '10.20.0.2')).toEqual({ allowed: false });
    expect(await check('10.10.0.20', '10.10.0.2', { 'x-forwarded-for': '10.10.0.20' })).toEqual({ allowed: false });
    expect(await check()).toEqual({ allowed: false });
    present = false;
    expect(await check('10.10.0.20')).toEqual({ allowed: false });
  });
});
