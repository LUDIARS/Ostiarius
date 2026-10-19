import { describe, expect, it, vi } from 'vitest';
import { resolveCloudflareToken } from '../server/acme/excubitor-token.ts';

const env = { EXCUBITOR_URL: 'http://127.0.0.1:17332', EXCUBITOR_AGENT_TOKEN: 'agent-secret' };
const success = () => new Response(JSON.stringify({ source: 'vault', secrets: { CLIENT_SECRET: 'cf-secret' } }));
describe('ACME Excubitor token source', () => {
  it('preserves explicit token without reading files or network', async () => {
    const fetchImpl = vi.fn(); const readTokenFile = vi.fn();
    expect(await resolveCloudflareToken({ CLOUDFLARE_DNS_API_TOKEN: ' explicit ' }, { fetchImpl, readTokenFile })).toBe('explicit');
    expect(fetchImpl).not.toHaveBeenCalled(); expect(readTokenFile).not.toHaveBeenCalled();
  });
  it('requests only the bound Os Cloudflare key', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(success());
    expect(await resolveCloudflareToken(env, { fetchImpl })).toBe('cf-secret');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('http://127.0.0.1:17332/api/v1/secrets/resolve');
    expect(JSON.parse(String(init?.body))).toEqual({ service: 'ostiarius-acme', keys: ['CLIENT_SECRET'] });
    expect(init?.redirect).toBe('error'); expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
  it('reads the existing token file without creating one', async () => {
    const readTokenFile = vi.fn().mockResolvedValue('agent-file-token\n');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(success());
    await resolveCloudflareToken({ EXCUBITOR_URL: env.EXCUBITOR_URL, EXCUBITOR_AGENT_TOKEN_PATH: 'explicit-token-path' }, { readTokenFile, fetchImpl });
    expect(readTokenFile).toHaveBeenCalledWith('explicit-token-path');
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer agent-file-token' });
  });
  it('pins localhost to a numeric loopback address', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(success());
    await resolveCloudflareToken({ ...env, EXCUBITOR_URL: 'http://localhost:17332' }, { fetchImpl });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('http://127.0.0.1:17332/api/v1/secrets/resolve');
  });
  it.each(['https://example.com', 'http://127.0.0.1:17332/path', 'http://user:pass@127.0.0.1:17332'])('rejects untrusted endpoints: %s', async (url) => {
    const fetchImpl = vi.fn();
    await expect(resolveCloudflareToken({ ...env, EXCUBITOR_URL: url }, { fetchImpl })).rejects.toThrow('loopback');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('does not expose HTTP error bodies or network causes', async () => {
    await expect(resolveCloudflareToken(env, { fetchImpl: vi.fn().mockResolvedValue(new Response('secret-value', { status: 403 })) })).rejects.toThrow('HTTP 403');
    await expect(resolveCloudflareToken(env, { fetchImpl: vi.fn().mockRejectedValue(new Error('secret-value')) })).rejects.toThrow('connection failed');
  });
  it('rejects missing bindings and non-vault responses', async () => {
    for (const body of [{ source: 'vault', secrets: {} }, { source: 'infisical', secrets: { CLIENT_SECRET: 'secret' } }]) {
      await expect(resolveCloudflareToken(env, { fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify(body))) })).rejects.toThrow('required Os Vault token');
    }
  });
});
