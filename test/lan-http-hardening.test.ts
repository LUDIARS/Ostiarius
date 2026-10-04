import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { createLanGuard, createSecureLanGuard } from '../server/face/lan-guard.ts';
import { FORWARDED_HEADERS, hasForwardedHeaders } from '../server/http-security/forwarded-headers.ts';
import { createAllowedHostsResolver, isAllowedHost } from '../server/http-security/host-allowlist.ts';
import { installLanHardening } from '../server/http-security/install.ts';
import { assertOriginAllowlist, resolveAllowedOrigin } from '../server/http-security/origin-allowlist.ts';
import { hitRateLimit, type RateLimitBuckets } from '../server/http-security/rate-limit.ts';
import { consumeRequestNonce, RequestNonceStore } from '../server/http-security/request-nonce.ts';
import { buildSecurityHeaders } from '../server/http-security/security-headers.ts';
import { SECURE_CONTEXT_METHODS } from '../server/http-security/secure-context.ts';
import { classifyTransport } from '../server/http-security/transport.ts';
import { makeMobileCheckinRouter, publicProfile } from '../server/routes/mobile-checkin.ts';
import type { MobileCheckinDeps } from '../server/mobile-checkin.ts';

const PORT = 17590;
const PWA_ORIGIN = 'https://pwa.example.test';
const CERNERE_ORIGIN = 'https://cernere.example.test';
const LAN_PEER = '192.168.1.20';
const LAN_HOST = `192.168.1.10:${PORT}`;
const PUBLIC_PEER = '203.0.113.7';

/**
 * 防御 middleware を本番と同じ順序で組み、route は応答だけ返す stub にした app。
 * 接続元アドレスは node-server の socket を持たないので resolver で差し替える。
 */
function harness(options: { remote?: string | null; limit?: number } = {}) {
  let remote: string | null = options.remote ?? LAN_PEER;
  const resolve = () => remote;
  const app = new Hono();
  const { nonces } = installLanHardening(app, {
    port: PORT,
    corsOrigins: [PWA_ORIGIN],
    corsScopes: [{ pathPrefix: '/api/mfa/onsite/', origins: [CERNERE_ORIGIN], corsHeaders: 'router' }],
    isLan: createLanGuard(resolve),
    allowedHosts: createAllowedHostsResolver({ port: PORT, lanHostname: 'gate.venue.example', detectAddresses: () => ['192.168.1.10'] }),
    resolveRemoteAddress: resolve,
    rateLimitPolicy: { limit: options.limit ?? 30, windowMs: 60_000 },
  });
  const ok = (c: { json: (body: unknown) => Response }) => c.json({ ok: true });
  app.post('/identity/session', ok);
  app.post('/kiosk/identity/session', ok);
  app.post('/identity/enroll/photo', ok);
  app.post('/identity/enroll/start', ok);
  app.get('/identity/face-photo/:userId', ok);
  app.post('/identity/face/frame', ok);
  app.post('/kiosk/mfa/:id/face/frame', ok);
  app.post('/identity/staff/begin', ok);
  app.post('/checkin/mobile-login', ok);
  app.post('/checkin/begin', ok);
  app.get('/api/health', ok);
  app.use('/api/mfa/onsite/*', cors({ origin: CERNERE_ORIGIN, allowMethods: ['GET', 'POST', 'OPTIONS'] }));
  app.post('/api/mfa/onsite/sessions', ok);
  return { app, nonces, setRemote: (value: string | null) => { remote = value; } };
}

async function issueNonce(app: Hono, base = `http://${LAN_HOST}`): Promise<string> {
  const response = await app.request(`${base}/api/lan/nonce`, { method: 'POST' });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return (await response.json() as { nonce: string }).nonce;
}

describe('classifyTransport', () => {
  it('counts only TLS or an unrelayed loopback connection as secure', () => {
    expect(classifyTransport({ tls: true, forwarded: false, remoteAddress: LAN_PEER })).toBe('tls');
    expect(classifyTransport({ tls: false, forwarded: false, remoteAddress: '127.0.0.1' })).toBe('loopback');
    expect(classifyTransport({ tls: false, forwarded: false, remoteAddress: '::1' })).toBe('loopback');
    expect(classifyTransport({ tls: false, forwarded: true, remoteAddress: '127.0.0.1' })).toBe('insecure');
    expect(classifyTransport({ tls: false, forwarded: false, remoteAddress: LAN_PEER })).toBe('insecure');
    expect(classifyTransport({ tls: false, forwarded: false, remoteAddress: null })).toBe('insecure');
  });

  it('shares one forwarding-header list across the LAN, kiosk and Cocoiru guards', () => {
    for (const header of FORWARDED_HEADERS) {
      expect(hasForwardedHeaders(new Headers({ [header]: '1' })), header).toBe(true);
    }
    expect(hasForwardedHeaders(new Headers({ host: 'localhost' }))).toBe(false);
  });
});

describe('photo, template and enrollment routes over plain HTTP', () => {
  it('rejects them from another LAN device with a fixed reason code', async () => {
    const { app } = harness();
    const routes: Array<[string, string]> = [
      ['POST', '/identity/enroll/photo'],
      ['GET', '/identity/face-photo/user-1'],
      ['POST', '/identity/face/frame'],
      ['POST', '/kiosk/mfa/session-1/face/frame'],
      ['POST', '/identity/staff/begin'],
    ];
    for (const [method, path] of routes) {
      const response = await app.request(`http://${LAN_HOST}${path}`, { method });
      expect(response.status, path).toBe(403);
      expect(await response.json(), path).toEqual({ error: 'secure_transport_required' });
    }
  });

  it('allows them on the kiosk host itself (loopback) and over TLS', async () => {
    const loopback = harness({ remote: '127.0.0.1' });
    expect((await loopback.app.request(`http://localhost:${PORT}/identity/enroll/photo`, { method: 'POST' })).status).toBe(200);
    const tls = harness();
    expect((await tls.app.request(`https://${LAN_HOST}/identity/face-photo/user-1`)).status).toBe(200);
  });

  it('keeps answering lan_only to requests from outside the venue LAN', async () => {
    const { app } = harness({ remote: PUBLIC_PEER });
    const response = await app.request(`https://${LAN_HOST}/identity/enroll/photo`, { method: 'POST' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'lan_only' });
  });

  it('refuses the password check-in over plain HTTP before the password is processed', async () => {
    const { app, nonces } = harness();
    const nonce = nonces.issue().nonce;
    const response = await app.request(`http://${LAN_HOST}/checkin/mobile-login`, { method: 'POST', headers: { 'x-ostiarius-nonce': nonce } });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'secure_transport_required' });
    // 断った要求では nonce を消費しない。
    expect(nonces.isOutstanding(nonce)).toBe(true);
  });

  it('createSecureLanGuard adds the TLS-or-loopback condition to the LAN guard', async () => {
    const probe = (remote: string | null) => {
      const app = new Hono();
      const guard = createSecureLanGuard(() => remote);
      app.get('/probe', (c) => c.json({ ok: guard(c) }));
      return app;
    };
    expect(await (await probe(LAN_PEER).request('http://x/probe')).json()).toEqual({ ok: false });
    expect(await (await probe(LAN_PEER).request('https://x/probe')).json()).toEqual({ ok: true });
    expect(await (await probe('127.0.0.1').request('http://x/probe')).json()).toEqual({ ok: true });
    expect(await (await probe('127.0.0.1').request('http://x/probe', { headers: { 'x-forwarded-for': '1.2.3.4' } })).json()).toEqual({ ok: false });
  });
});

describe('server-issued request nonce', () => {
  it('rejects a state-changing LAN request without a nonce', async () => {
    const { app } = harness({ remote: '127.0.0.1' });
    const response = await app.request(`http://localhost:${PORT}/kiosk/identity/session`, { method: 'POST' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'nonce_required' });
  });

  it('accepts a fresh nonce once and rejects its replay', async () => {
    const { app } = harness({ remote: '127.0.0.1' });
    const nonce = await issueNonce(app, `http://localhost:${PORT}`);
    const first = await app.request(`http://localhost:${PORT}/identity/session`, { method: 'POST', headers: { 'x-ostiarius-nonce': nonce } });
    expect(first.status).toBe(200);
    const replay = await app.request(`http://localhost:${PORT}/identity/session`, { method: 'POST', headers: { 'x-ostiarius-nonce': nonce } });
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ error: 'nonce_rejected' });
  });

  it('rejects a nonce the server never issued or that has expired', () => {
    const store = new RequestNonceStore(-1);
    const { nonce } = store.issue();
    expect(consumeRequestNonce(store, nonce)).toBe('rejected');
    expect(consumeRequestNonce(store, 'forged')).toBe('rejected');
    expect(consumeRequestNonce(store, undefined)).toBe('missing');
  });

  it('does not demand a nonce from WebAuthn begin (its challenge already is one)', async () => {
    const { app } = harness();
    expect((await app.request(`http://${LAN_HOST}/checkin/begin`, { method: 'POST' })).status).toBe(200);
  });
});

describe('Host allowlist (DNS rebinding)', () => {
  it('rejects a Host that is not this gateway', async () => {
    const { app } = harness();
    for (const host of ['attacker.example', `attacker.example:${PORT}`, '192.168.1.99:17590', `192.168.1.10:8080`]) {
      const response = await app.request(`http://${host}/api/health`);
      expect(response.status, host).toBe(421);
      expect(await response.json()).toEqual({ error: 'misdirected_host' });
    }
  });

  it('accepts the detected LAN IPv4, loopback names and OSTIARIUS_LAN_HOSTNAME', async () => {
    const { app } = harness();
    for (const host of [LAN_HOST, `localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`, `gate.venue.example:${PORT}`, 'localhost']) {
      expect((await app.request(`http://${host}/api/health`)).status, host).toBe(200);
    }
  });

  it('isAllowedHost compares names case-insensitively and pins the port', () => {
    const allowed = { names: new Set(['localhost', '192.168.1.10']), port: PORT };
    expect(isAllowedHost(`LOCALHOST:${PORT}`, allowed)).toBe(true);
    expect(isAllowedHost('localhost:1', allowed)).toBe(false);
    expect(isAllowedHost(undefined, allowed)).toBe(false);
    expect(isAllowedHost('', allowed)).toBe(false);
  });
});

describe('CORS allowlist', () => {
  it('rejects requests and preflights from an origin outside the allowlist', async () => {
    const { app } = harness();
    const post = await app.request(`http://${LAN_HOST}/checkin/begin`, { method: 'POST', headers: { origin: 'https://evil.example' } });
    expect(post.status).toBe(403);
    expect(await post.json()).toEqual({ error: 'origin_not_allowed' });
    const preflight = await app.request(`http://${LAN_HOST}/checkin/begin`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('echoes only the exact allow-listed origin and never sends credentials', async () => {
    const { app } = harness();
    const preflight = await app.request(`http://${LAN_HOST}/checkin/begin`, {
      method: 'OPTIONS',
      headers: { origin: PWA_ORIGIN, 'access-control-request-method': 'POST' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(PWA_ORIGIN);
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull();
    const post = await app.request(`http://${LAN_HOST}/checkin/begin`, { method: 'POST', headers: { origin: PWA_ORIGIN } });
    expect(post.headers.get('access-control-allow-origin')).toBe(PWA_ORIGIN);
  });

  it('scopes the onsite MFA API to the Cernere origin only', async () => {
    const { app } = harness();
    const pwa = await app.request(`http://${LAN_HOST}/api/mfa/onsite/sessions`, { method: 'POST', headers: { origin: PWA_ORIGIN } });
    expect(pwa.status).toBe(403);
    const cernere = await app.request(`http://${LAN_HOST}/api/mfa/onsite/sessions`, { method: 'POST', headers: { origin: CERNERE_ORIGIN } });
    expect(cernere.status).toBe(200);
    expect(cernere.headers.get('access-control-allow-origin')).toBe(CERNERE_ORIGIN);
  });

  it('lets same-origin pages through and refuses wildcard configuration', async () => {
    const { app } = harness({ remote: '127.0.0.1' });
    const sameOrigin = await app.request(`http://localhost:${PORT}/api/lan/nonce`, { method: 'POST', headers: { origin: `http://localhost:${PORT}` } });
    expect(sameOrigin.status).toBe(200);
    expect(() => assertOriginAllowlist(['*'])).toThrow();
    expect(() => assertOriginAllowlist(['https://ok.example/path'])).toThrow();
    expect(resolveAllowedOrigin('*', ['*'])).toBeNull();
    expect(resolveAllowedOrigin('null', [PWA_ORIGIN])).toBeNull();
  });
});

describe('security headers', () => {
  it('adds CSP, framing, sniffing, referrer and cache headers to every response, including rejections', async () => {
    const { app } = harness();
    for (const response of [
      await app.request(`http://${LAN_HOST}/api/health`),
      await app.request('http://attacker.example/api/health'),
      await app.request(`http://${LAN_HOST}/identity/enroll/photo`, { method: 'POST' }),
    ]) {
      const csp = response.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('allows inline scripts only through the per-response nonce', () => {
    const headers = buildSecurityHeaders('abc123');
    const scriptSrc = headers['content-security-policy']!.split(';').map((part) => part.trim()).find((part) => part.startsWith('script-src'));
    expect(scriptSrc).toBe("script-src 'self' 'nonce-abc123'");
  });
});

describe('rate limiting', () => {
  it('answers 429 with Retry-After once a LAN peer exceeds the limit', async () => {
    const { app } = harness({ limit: 2 });
    for (let index = 0; index < 2; index += 1) {
      expect((await app.request(`http://${LAN_HOST}/checkin/begin`, { method: 'POST' })).status).toBe(200);
    }
    const limited = await app.request(`http://${LAN_HOST}/checkin/begin`, { method: 'POST' });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'rate_limited' });
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  });

  it('counts each peer separately and does not throttle the kiosk host', async () => {
    const { app, setRemote } = harness({ limit: 1 });
    expect((await app.request(`http://${LAN_HOST}/checkin/begin`, { method: 'POST' })).status).toBe(200);
    expect((await app.request(`http://${LAN_HOST}/checkin/begin`, { method: 'POST' })).status).toBe(429);
    setRemote('192.168.1.21');
    expect((await app.request(`http://${LAN_HOST}/checkin/begin`, { method: 'POST' })).status).toBe(200);
    setRemote('127.0.0.1');
    for (let index = 0; index < 3; index += 1) {
      expect((await app.request(`http://localhost:${PORT}/checkin/begin`, { method: 'POST' })).status).toBe(200);
    }
  });

  it('hitRateLimit opens a new window once the old one has passed', () => {
    const buckets: RateLimitBuckets = new Map();
    const policy = { limit: 1, windowMs: 1000 };
    expect(hitRateLimit(buckets, 'a', 0, policy).allowed).toBe(true);
    expect(hitRateLimit(buckets, 'a', 500, policy)).toEqual({ allowed: false, retryAfterSec: 1 });
    expect(hitRateLimit(buckets, 'a', 1000, policy).allowed).toBe(true);
  });
});

describe('personal data and secure context', () => {
  it('drops the name from the profile returned to LAN clients', () => {
    expect(publicProfile({ departmentName: 'Game', grade: 2, name: 'Taro', desiredJob: 'planner' })).toEqual({ departmentName: 'Game', grade: 2 });
    expect(publicProfile(null)).toBeNull();
  });

  it('lists the methods that need a secure context for /api/health and the pages alike', () => {
    expect(SECURE_CONTEXT_METHODS).toEqual(['passkey', 'camera']);
  });

  it('hides the password form on a non-secure page, asks for a nonce and runs under the CSP nonce', async () => {
    const app = new Hono();
    app.route('/', makeMobileCheckinRouter({
      wifiSsid: '', wifiPassword: '', aedilisBaseUrl: 'https://ae.example.test',
      sessionCheckinEnabled: false, passwordCheckinEnabled: true, loginDeps: {} as MobileCheckinDeps,
    }));
    const html = await (await app.request('http://localhost/mobile-checkin')).text();
    expect(html).toMatch(/<script nonce="[^"]+">/);
    expect(html).toContain('window.isSecureContext');
    expect(html).toContain('<div data-requires-secure-context>');
    expect(html).toContain('data-insecure-context-guidance');
    expect(html).toContain("'x-ostiarius-nonce'");
    expect(html).not.toContain('profile.name');
  });
});
