import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { Hono } from 'hono';

import { ATTESTATION_FIELD_ORDER, b64urlDecode, signAttestation, verifyAttestation } from '../server/attestation.ts';
import { isRateLimitedRoute } from '../server/http-security/lan-routes.ts';
import { makeVenueRegistrationRouter } from '../server/routes/venue-registration.ts';
import { signVenueRegistrationAttestation } from '../server/venue-registration/attestation.ts';
import { submitCernereAttestation } from '../server/cernere-attestation-submit.ts';
import { submitVenueRegistrationAttestation, VENUE_REGISTRATION_ENDPOINT, venueRegistrationSubmitter } from '../server/venue-registration/cernere-submit.ts';
import { issueVenueRegistration } from '../server/venue-registration/issue.ts';
import { VenueRegistrationNonceLedger } from '../server/venue-registration/nonce-ledger.ts';

const CERNERE_ORIGIN = 'https://cernere.example.test';
const CERNERE_BASE = 'https://cernere-api.example.test';
const FACILITY_ID = '6f1c2b8e-4d3a-4f6b-9c2d-1a2b3c4d5e6f';
const LAN_ID = 'lan-glab-test';

interface CernereCall { url: string; headers: Record<string, string>; body: string }

function nonce(): string {
  return randomBytes(32).toString('base64url');
}

function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(b64urlDecode(token.split('.')[0] ?? '').toString('utf8')) as Record<string, unknown>;
}

function cernereResponse(status: number, body: unknown) {
  const calls: CernereCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: String(init?.body) });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function setup(options: { lan?: boolean; cernere?: { status: number; body: unknown }; fetchImpl?: typeof fetch } = {}) {
  const clock = 1_800_000_000_000;
  const keyPair = generateKeyPairSync('ed25519');
  const cernere = cernereResponse(options.cernere?.status ?? 200, options.cernere?.body ?? { accepted: true });
  const nonces = new VenueRegistrationNonceLedger({ now: () => clock });
  const app = new Hono();
  app.route('/', makeVenueRegistrationRouter({
    isLan: () => options.lan ?? true,
    corsOrigin: CERNERE_ORIGIN,
    issue: {
      nonces,
      privateKey: keyPair.privateKey,
      lanId: LAN_ID,
      facilityId: FACILITY_ID,
      submit: venueRegistrationSubmitter({
        cernereBaseUrl: CERNERE_BASE,
        serviceToken: async () => 'project-token',
        fetchImpl: options.fetchImpl ?? cernere.fetchImpl,
      }),
    },
  }));
  const post = (body: unknown, headers: Record<string, string> = {}) => app.request('/api/venue-registration/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { app, post, cernere, keyPair, clock };
}

describe('venue registration attestation (venue-registration §3)', () => {
  it('signs {sub:null, placeId, lanId, nonce, issuedAt, method:lan, assurance:network, purpose:registration} in the fixed order', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const token = signVenueRegistrationAttestation({ placeId: FACILITY_ID, lanId: LAN_ID, nonce: 'n-1', issuedAt: 1_700_000_000_000 }, privateKey);
    const payload = decodePayload(token);
    expect(Object.keys(payload)).toEqual([...ATTESTATION_FIELD_ORDER]);
    expect(payload).toEqual({
      sub: null, placeId: FACILITY_ID, lanId: LAN_ID, nonce: 'n-1', issuedAt: 1_700_000_000_000,
      method: 'lan', assurance: 'network', purpose: 'registration',
    });
    expect(verifyAttestation(token, publicKey).ok).toBe(true);
  });
});

describe('venue registration submit to Cernere (venue-registration §6)', () => {
  const registration = () => signVenueRegistrationAttestation({ placeId: FACILITY_ID, lanId: LAN_ID, nonce: nonce(), issuedAt: Date.now() }, generateKeyPairSync('ed25519').privateKey);

  it('posts only the attestation with the project token and reads accepted', async () => {
    const cernere = cernereResponse(200, { accepted: true });
    const token = registration();
    const result = await submitVenueRegistrationAttestation({ cernereBaseUrl: `${CERNERE_BASE}/`, serviceToken: async () => 'project-token', fetchImpl: cernere.fetchImpl }, token);
    expect(result).toEqual({ status: 'accepted' });
    expect(cernere.calls).toHaveLength(1);
    expect(cernere.calls[0]?.url).toBe(`${CERNERE_BASE}/api/auth/venue-registration/attestations`);
    expect(cernere.calls[0]?.headers.authorization).toBe('Bearer project-token');
    expect(JSON.parse(cernere.calls[0]?.body ?? '{}')).toEqual({ attestation: token });
  });

  it('maps the fixed Cernere vocabulary and local failures', async () => {
    for (const code of ['nonce_unknown', 'nonce_used', 'stale', 'place_not_allowed', 'organization_unknown', 'purpose_mismatch']) {
      const cernere = cernereResponse(400, { error: code });
      expect(await submitVenueRegistrationAttestation({ cernereBaseUrl: CERNERE_BASE, serviceToken: async () => 't', fetchImpl: cernere.fetchImpl }, registration()))
        .toEqual({ status: 'rejected', error: code });
    }
    const forbidden = cernereResponse(403, { error: 'insufficient_scope' });
    expect(await submitVenueRegistrationAttestation({ cernereBaseUrl: CERNERE_BASE, serviceToken: async () => 't', fetchImpl: forbidden.fetchImpl }, registration()))
      .toEqual({ status: 'rejected', error: 'submit_unauthorized' });
    expect(await submitVenueRegistrationAttestation({ cernereBaseUrl: CERNERE_BASE, serviceToken: async () => '' }, registration()))
      .toEqual({ status: 'rejected', error: 'service_token_unavailable' });
    const down = (async () => { throw new Error('down'); }) as typeof fetch;
    expect(await submitVenueRegistrationAttestation({ cernereBaseUrl: CERNERE_BASE, serviceToken: async () => 't', fetchImpl: down }, registration()))
      .toEqual({ status: 'rejected', error: 'cernere_unreachable' });
  });

  it('never sends an mfa or attendance attestation to the venue registration endpoint', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    for (const purpose of ['mfa', 'attendance'] as const) {
      const cernere = cernereResponse(200, { accepted: true });
      const token = signAttestation({ sub: 'user-1', placeId: FACILITY_ID, lanId: LAN_ID, nonce: nonce(), issuedAt: Date.now(), method: 'face', assurance: 'high', purpose }, privateKey);
      // 契約 C-25 の pre (registration だけを渡す) を破らないよう、ガードを持つ共通部を直接呼ぶ。
      expect(await submitCernereAttestation(VENUE_REGISTRATION_ENDPOINT, { cernereBaseUrl: CERNERE_BASE, serviceToken: async () => 't', fetchImpl: cernere.fetchImpl }, token))
        .toEqual({ status: 'rejected', error: 'purpose_not_allowed' });
      expect(cernere.calls).toHaveLength(0);
    }
  });
});

describe('issueVenueRegistration (venue-registration §2)', () => {
  it('signs and submits a nonce once and rejects the replay without submitting again', async () => {
    const submitted: string[] = [];
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const deps = {
      nonces: new VenueRegistrationNonceLedger({ now: () => 42 }),
      privateKey, lanId: LAN_ID, facilityId: FACILITY_ID,
      submit: async (attestation: string) => { submitted.push(attestation); return { status: 'accepted' as const }; },
    };
    const value = nonce();
    expect(await issueVenueRegistration(deps, value)).toEqual({ status: 'accepted' });
    expect(await issueVenueRegistration(deps, value)).toEqual({ status: 'rejected', error: 'nonce_reused' });
    expect(submitted).toHaveLength(1);
    expect(verifyAttestation(submitted[0] ?? '', publicKey).ok).toBe(true);
    expect(decodePayload(submitted[0] ?? '')).toMatchObject({ sub: null, nonce: value, issuedAt: 42, placeId: FACILITY_ID, lanId: LAN_ID, purpose: 'registration' });
  });

  it('forgets nonces after the retention window', () => {
    let clock = 0;
    const ledger = new VenueRegistrationNonceLedger({ retentionMs: 1_000, now: () => clock });
    expect(ledger.claim('a')).toBe(true);
    expect(ledger.claim('a')).toBe(false);
    clock = 1_000;
    expect(ledger.claim('a')).toBe(true);
  });

  it('turns a throwing submitter into submit_failed', async () => {
    const deps = {
      nonces: new VenueRegistrationNonceLedger(), privateKey: generateKeyPairSync('ed25519').privateKey, lanId: LAN_ID, facilityId: FACILITY_ID,
      submit: async () => { throw new Error('boom'); },
    };
    expect(await issueVenueRegistration(deps, nonce())).toEqual({ status: 'rejected', error: 'submit_failed' });
  });
});

describe('POST /api/venue-registration/sessions (venue-registration §2)', () => {
  it('accepts a LAN nonce, signs it as registration and forwards it to Cernere', async () => {
    const { post, cernere, keyPair } = setup();
    const value = nonce();
    const res = await post({ nonce: value, userId: 'ignored' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ state: 'submitted' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(cernere.calls).toHaveLength(1);
    const { attestation } = JSON.parse(cernere.calls[0]?.body ?? '{}') as { attestation: string };
    expect(verifyAttestation(attestation, keyPair.publicKey).ok).toBe(true);
    expect(decodePayload(attestation)).toMatchObject({ sub: null, nonce: value, placeId: FACILITY_ID, lanId: LAN_ID, method: 'lan', assurance: 'network', purpose: 'registration' });
  });

  it('refuses requests from outside the facility LAN without contacting Cernere', async () => {
    const { post, cernere } = setup({ lan: false });
    const res = await post({ nonce: nonce() });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'lan_required' });
    expect(cernere.calls).toHaveLength(0);
  });

  it('rejects malformed nonces and replays', async () => {
    const { post, cernere } = setup();
    expect((await post({ nonce: 'short' })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    const value = nonce();
    expect((await post({ nonce: value })).status).toBe(202);
    const replay = await post({ nonce: value });
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ error: 'nonce_reused' });
    expect(cernere.calls).toHaveLength(1);
  });

  it('relays Cernere rejections as 422 and local send failures as 502', async () => {
    const rejected = setup({ cernere: { status: 400, body: { error: 'nonce_unknown' } } });
    const res = await rejected.post({ nonce: nonce() });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'nonce_unknown' });

    const unreachable = setup({ fetchImpl: (async () => { throw new Error('down'); }) as typeof fetch });
    const failed = await unreachable.post({ nonce: nonce() });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: 'cernere_unreachable' });
  });

  it('allows CORS and Private Network Access only for the Cernere login origin', async () => {
    const { app } = setup();
    const preflight = await app.request('/api/venue-registration/sessions', {
      method: 'OPTIONS',
      headers: { origin: CERNERE_ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBe(CERNERE_ORIGIN);
    expect(preflight.headers.get('access-control-allow-private-network')).toBe('true');

    const foreign = await app.request('/api/venue-registration/sessions', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example.test', 'access-control-request-method': 'POST' },
    });
    expect(foreign.headers.get('access-control-allow-origin')).not.toBe('https://evil.example.test');
  });

  it('is rate limited per client like the onsite MFA entry', async () => {
    const app = new Hono();
    app.post('/api/venue-registration/sessions', (c) => c.json({ limited: isRateLimitedRoute(c) }));
    const res = await app.request('/api/venue-registration/sessions', { method: 'POST' });
    expect(await res.json()).toEqual({ limited: true });
  });
});
