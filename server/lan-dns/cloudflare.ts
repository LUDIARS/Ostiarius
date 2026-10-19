import type { LanDnsConfig } from './config.ts';
import { isPrivateIpv4 } from './address.ts';

interface DnsRecord { id: string; name: string; type: string; content: string; proxied: boolean }
interface Envelope<T> { success: boolean; result: T; result_info?: { total_pages?: number } }
export type DnsSyncResult = 'created' | 'updated' | 'unchanged';

/** Only the configured host's single DNS-only private A record is managed. */
export async function syncCloudflareLanDns(
  config: LanDnsConfig, address: string, fetchImpl: typeof fetch = fetch,
): Promise<DnsSyncResult> {
  if (!isPrivateIpv4(address)) throw new Error('LAN DNS requires a private IPv4 address');
  const request = async <T>(path: string, method = 'GET', payload?: object): Promise<Envelope<T>> => {
    let response: Response;
    try {
      response = await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
        method, redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${config.apiToken}`, 'Content-Type': 'application/json' },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });
    } catch {
      // Fetch causes and remote error bodies may contain credentials. Do not log them.
      throw new Error('LAN DNS request failed; outcome may be unknown; no automatic retry');
    }
    const data = await response.json().catch(() => null) as Envelope<T> | null;
    if (!response.ok || data?.success !== true || data.result == null) {
      throw new Error(`LAN DNS request failed (HTTP ${response.status}); no automatic retry`);
    }
    return data;
  };
  const base = `/zones/${encodeURIComponent(config.zoneId)}`;
  const zone = (await request<{ name: string }>(base)).result;
  if (typeof zone.name !== 'string' || !config.hostname.endsWith(`.${zone.name}`)) {
    throw new Error('LAN DNS hostname must be a subdomain of the configured zone');
  }
  const recordsPath = `${base}/dns_records`;
  const list = await request<DnsRecord[]>(`${recordsPath}?name=${encodeURIComponent(config.hostname)}&per_page=100`);
  if (!Array.isArray(list.result) || (list.result_info?.total_pages ?? 1) > 1) {
    throw new Error('LAN DNS record list is incomplete');
  }
  const records = list.result.filter((record) => record.name === config.hostname
    && ['A', 'AAAA', 'CNAME'].includes(record.type));
  const current = records[0];
  if (records.length > 1 || (current && (current.type !== 'A' || current.proxied !== false
    || !isPrivateIpv4(current.content) || !current.id))) {
    throw new Error('LAN DNS conflicts with existing records; no changes made');
  }
  if (current?.content === address) return 'unchanged';
  const result: DnsSyncResult = current ? 'updated' : 'created';
  const record = (await request<DnsRecord>(
    current ? `${recordsPath}/${encodeURIComponent(current.id)}` : recordsPath,
    current ? 'PATCH' : 'POST',
    current ? { content: address } : {
      type: 'A', name: config.hostname, content: address, ttl: 120, proxied: false,
    },
  )).result;
  if (!record.id) throw new Error('LAN DNS write outcome is unknown; missing record ID');
  const verified = (await request<DnsRecord>(`${recordsPath}/${encodeURIComponent(record.id)}`)).result;
  if (verified.name !== config.hostname || verified.type !== 'A' || verified.content !== address
    || verified.proxied !== false) throw new Error('LAN DNS read-back mismatch; no automatic retry');
  return result;
}
