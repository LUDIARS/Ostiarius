import { describe, expect, it, vi } from 'vitest';
import {
  acmeChallengeRecordName,
  CloudflareDnsClient,
  deriveZoneName,
} from '../server/acme/cloudflare-dns.ts';

describe('Cloudflare DNS-01 record naming', () => {
  it('derives the configured Cloudflare zone from the FQDN', () => {
    expect(deriveZoneName('os.example.com')).toBe('example.com');
  });

  it('creates the ACME TXT record below the requested hostname', () => {
    expect(acmeChallengeRecordName('os.example.com')).toBe('_acme-challenge.os.example.com');
  });

  it('resolves the zone and creates the expected TXT record through mocked fetch', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, errors: [], result: [{ id: 'zone-id', name: 'example.com' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, errors: [], result: { id: 'record-id' } }),
      }) as unknown as typeof fetch;
    const client = new CloudflareDnsClient({ apiToken: 'test-token', fetchImpl });

    await expect(client.createTxtRecord('os.example.com', 'dns-value')).resolves.toEqual({
      id: 'record-id',
      name: '_acme-challenge.os.example.com',
      zoneId: 'zone-id',
    });
    expect(fetchImpl).toHaveBeenLastCalledWith(
      'https://api.cloudflare.com/client/v4/zones/zone-id/dns_records',
      expect.objectContaining({
        body: JSON.stringify({ type: 'TXT', name: '_acme-challenge.os.example.com', content: 'dns-value', ttl: 120 }),
      }),
    );
  });

  it('reports the HTTP status when the error body is not Cloudflare JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    }) as unknown as typeof fetch;
    const client = new CloudflareDnsClient({ apiToken: 'test-token', fetchImpl });

    await expect(client.createTxtRecord('os.example.com', 'dns-value')).rejects.toThrow(
      'Cloudflare DNS request failed (502)',
    );
  });
});
