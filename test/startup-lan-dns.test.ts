import { describe, expect, it, vi } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { loadLanDnsConfig } from '../server/lan-dns/config.ts';
import { selectLanDnsAddress } from '../server/lan-dns/address.ts';
import { syncCloudflareLanDns } from '../server/lan-dns/cloudflare.ts';
import { updateStartupLanDns } from '../server/lan-dns/startup.ts';

const config = { hostname: 'lan.example.com', zoneId: 'a'.repeat(32), apiToken: 'secret-token', interfaceName: 'Wi-Fi' };
const record = { id: 'record-id', name: config.hostname, type: 'A', content: '192.168.1.2', proxied: false };
const response = (result: unknown): Response => new Response(JSON.stringify({ success: true, result }));
function api(records: unknown[], verified = record) {
  return vi.fn<typeof fetch>()
    .mockResolvedValueOnce(response({ name: 'example.com' }))
    .mockResolvedValueOnce(response(records))
    .mockResolvedValueOnce(response(record))
    .mockResolvedValueOnce(response(verified));
}
const adapter = (address: string): NetworkInterfaceInfo => ({
  address, family: 'IPv4', internal: false, cidr: `${address}/24`, netmask: '255.255.255.0', mac: '00:00:00:00:00:00',
});

describe('startup LAN DNS', () => {
  it('leaves existing deployments off and validates explicit enablement', async () => {
    expect(loadLanDnsConfig({})).toBeNull();
    expect(await updateStartupLanDns({})).toBe('off');
    expect(() => loadLanDnsConfig({ OSTIARIUS_LAN_DNS_MODE: 'typo' })).toThrow();
    expect(() => loadLanDnsConfig({ OSTIARIUS_LAN_DNS_MODE: 'cloudflare' })).toThrow('HOSTNAME');
    expect(loadLanDnsConfig({ OSTIARIUS_LAN_DNS_MODE: 'cloudflare', OSTIARIUS_LAN_HOSTNAME: config.hostname,
      OSTIARIUS_LAN_DNS_ZONE_ID: config.zoneId, CLOUDFLARE_DNS_API_TOKEN: config.apiToken,
      OSTIARIUS_LAN_DNS_INTERFACE: 'Wi-Fi' })).toEqual(config);
  });
  it('selects only the configured adapter and rejects ambiguity', () => {
    expect(selectLanDnsAddress('Wi-Fi', { 'Wi-Fi': [adapter('192.168.1.2')], VPN: [adapter('10.1.1.2')] })).toBe('192.168.1.2');
    expect(() => selectLanDnsAddress('Wi-Fi', {})).toThrow('exactly one');
    expect(() => selectLanDnsAddress('Wi-Fi', { 'Wi-Fi': [adapter('192.168.1.2'), adapter('192.168.1.3')] })).toThrow();
    expect(() => selectLanDnsAddress('Wi-Fi', { 'Wi-Fi': [adapter('8.8.8.8')] })).toThrow();
  });
  it('performs no write for an unchanged address', async () => {
    const fetchImpl = api([record]);
    expect(await syncCloudflareLanDns(config, record.content, fetchImpl)).toBe('unchanged');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('creates a DNS-only private record and reads back', async () => {
    const fetchImpl = api([{ name: config.hostname, type: 'TXT' }]);
    expect(await syncCloudflareLanDns(config, record.content, fetchImpl)).toBe('created');
    const init = fetchImpl.mock.calls[2]?.[1];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ type: 'A', name: config.hostname, content: record.content, ttl: 120, proxied: false });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
  it('patches only the IP, retaining existing metadata', async () => {
    const fetchImpl = api([{ ...record, content: '192.168.1.100' }]);
    expect(await syncCloudflareLanDns(config, record.content, fetchImpl)).toBe('updated');
    expect(fetchImpl.mock.calls[2]?.[1]?.method).toBe('PATCH');
    expect(JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body))).toEqual({ content: record.content });
  });
  it.each([
    [{ ...record, type: 'CNAME' }], [{ ...record, type: 'AAAA' }],
    [{ ...record, proxied: true }], [{ ...record, content: '8.8.8.8' }], [record, record],
  ])('refuses conflicting records without writes: %j', async (...records) => {
    const fetchImpl = api(records);
    await expect(syncCloudflareLanDns(config, record.content, fetchImpl)).rejects.toThrow('conflicts');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('rejects zone mismatches and public target addresses', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ name: 'other.com' }));
    await expect(syncCloudflareLanDns(config, record.content, fetchImpl)).rejects.toThrow('subdomain');
    await expect(syncCloudflareLanDns(config, '8.8.8.8', fetchImpl)).rejects.toThrow('private');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('does not retry uncertain writes or expose secrets in network errors', async () => {
    const fetchImpl = api([]).mockReset()
      .mockResolvedValueOnce(response({ name: 'example.com' }))
      .mockResolvedValueOnce(response([]))
      .mockRejectedValueOnce(new Error(config.apiToken));
    await expect(syncCloudflareLanDns(config, record.content, fetchImpl)).rejects.toThrow('outcome may be unknown');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[2]?.[1]?.redirect).toBe('error');
    expect(fetchImpl.mock.calls[2]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
  it('fails on read-back mismatch', async () => {
    await expect(syncCloudflareLanDns(config, record.content, api([], { ...record, content: '192.168.1.99' })))
      .rejects.toThrow('read-back mismatch');
  });
  it('redacts remote error bodies', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(config.apiToken, { status: 403 }));
    await expect(syncCloudflareLanDns(config, record.content, fetchImpl)).rejects.toThrow('HTTP 403');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
