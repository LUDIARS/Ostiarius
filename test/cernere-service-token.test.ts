import { describe, expect, it, vi } from 'vitest';

import { createServiceTokenProvider, staticServiceTokenProvider } from '../server/cernere-service-token.ts';

const BASE_URL = 'https://cernere.example';

function loginResponse(token: string, expiresIn?: number) {
  return new Response(JSON.stringify({ tokenType: 'project', accessToken: token, expiresIn }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createServiceTokenProvider', () => {
  it('exchanges project client credentials for a token', async () => {
    const fetchImpl = vi.fn(async () => loginResponse('token-1', 3600));
    const provider = createServiceTokenProvider({
      cernereBaseUrl: `${BASE_URL}/`,
      clientId: 'client',
      clientSecret: 'secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider()).resolves.toBe('token-1');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/auth/login`);
    expect(JSON.parse(String(init.body))).toEqual({
      grant_type: 'project_credentials',
      client_id: 'client',
      client_secret: 'secret',
    });
    expect(init.redirect).toBe('error');
  });

  it('reuses the cached token until it is close to expiry', async () => {
    let issued = 0;
    const fetchImpl = vi.fn(async () => loginResponse(`token-${++issued}`, 3600));
    let clock = 0;
    const provider = createServiceTokenProvider({
      cernereBaseUrl: BASE_URL,
      clientId: 'client',
      clientSecret: 'secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => clock,
    });

    await expect(provider()).resolves.toBe('token-1');
    clock = 3_500_000; // 期限 (3600s - 60s の猶予) の手前
    await expect(provider()).resolves.toBe('token-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    clock = 3_541_000; // 猶予を引いた期限を越えた
    await expect(provider()).resolves.toBe('token-2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('shares one login between concurrent callers', async () => {
    // Cernere は project_login に 10 回 / 5 分のレートリミットを持つため、
    // 同時に呼ばれても login は 1 回で済ませる。
    const fetchImpl = vi.fn(async () => loginResponse('token-1', 3600));
    const provider = createServiceTokenProvider({
      cernereBaseUrl: BASE_URL,
      clientId: 'client',
      clientSecret: 'secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(Promise.all([provider(), provider(), provider()])).resolves.toEqual(['token-1', 'token-1', 'token-1']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not treat a missing expiresIn as an unlimited lifetime', async () => {
    let issued = 0;
    const fetchImpl = vi.fn(async () => loginResponse(`token-${++issued}`));
    let clock = 0;
    const provider = createServiceTokenProvider({
      cernereBaseUrl: BASE_URL,
      clientId: 'client',
      clientSecret: 'secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => clock,
    });

    await expect(provider()).resolves.toBe('token-1');
    clock = 5 * 60_000; // fallback TTL (5 分) から猶予を引いた分は既に過ぎている
    await expect(provider()).resolves.toBe('token-2');
  });

  it('uses the fallback lifetime for a non-finite expiresIn', async () => {
    let issued = 0;
    const fetchImpl = vi.fn(async () => new Response(
      `{"tokenType":"project","accessToken":"token-${++issued}","expiresIn":1e999}`,
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    let clock = 0;
    const provider = createServiceTokenProvider({
      cernereBaseUrl: BASE_URL,
      clientId: 'client',
      clientSecret: 'secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => clock,
    });

    await expect(provider()).resolves.toBe('token-1');
    clock = 5 * 60_000;
    await expect(provider()).resolves.toBe('token-2');
  });

  it('surfaces a failed login instead of caching an empty token', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
    const provider = createServiceTokenProvider({
      cernereBaseUrl: BASE_URL,
      clientId: 'client',
      clientSecret: 'secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider()).rejects.toThrow('HTTP 401');
    // 失敗を握り込まず、次の呼び出しでもう一度試せること。
    await expect(provider()).rejects.toThrow('HTTP 401');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a 200 response that carries no accessToken', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ tokenType: 'project' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const provider = createServiceTokenProvider({
      cernereBaseUrl: BASE_URL,
      clientId: 'client',
      clientSecret: 'secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider()).rejects.toThrow('no accessToken');
  });
});

describe('staticServiceTokenProvider', () => {
  it('returns the configured token as-is', async () => {
    await expect(staticServiceTokenProvider('fixed')()).resolves.toBe('fixed');
  });
});
