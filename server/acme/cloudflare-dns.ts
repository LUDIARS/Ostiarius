// Resolver は promises 版を使う。 node:dns の Resolver はコールバック API で、
// resolveTxt が Promise を返さない (void になる)。
import * as dns from 'node:dns/promises';
import { Resolver } from 'node:dns/promises';

const CLOUDFLARE_API_URL = 'https://api.cloudflare.com/client/v4';

interface CloudflareResult<T> {
  result: T;
  success: boolean;
  errors: Array<{ message?: string }>;
}

interface ZoneRecord {
  id: string;
  name: string;
}

interface DnsRecord {
  id: string;
}

export interface CloudflareDnsOptions {
  apiToken: string;
  fetchImpl?: typeof fetch;
  propagationTimeoutMs?: number;
}

export interface CreatedTxtRecord {
  id: string;
  name: string;
  zoneId: string;
}

/** The configured LAN hostname uses its registrable-looking final two labels as the zone name. */
export function deriveZoneName(hostname: string): string {
  const labels = hostname.trim().replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length < 2) {
    throw new Error(`OSTIARIUS_LAN_HOSTNAME must be a fully-qualified hostname: ${hostname}`);
  }
  return labels.slice(-2).join('.');
}

export function acmeChallengeRecordName(hostname: string): string {
  return `_acme-challenge.${hostname.trim().replace(/\.$/, '')}`;
}

export class CloudflareDnsClient {
  private readonly fetchImpl: typeof fetch;
  private readonly propagationTimeoutMs: number;

  constructor(private readonly options: CloudflareDnsOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.propagationTimeoutMs = options.propagationTimeoutMs ?? 120_000;
  }

  async createTxtRecord(hostname: string, value: string): Promise<CreatedTxtRecord> {
    const zoneId = await this.resolveZoneId(deriveZoneName(hostname));
    const name = acmeChallengeRecordName(hostname);
    const record = await this.request<DnsRecord>(`/zones/${encodeURIComponent(zoneId)}/dns_records`, {
      method: 'POST',
      body: JSON.stringify({ type: 'TXT', name, content: value, ttl: 120 }),
    });
    return { id: record.id, name, zoneId };
  }

  async deleteTxtRecord(record: CreatedTxtRecord): Promise<void> {
    await this.request<unknown>(
      `/zones/${encodeURIComponent(record.zoneId)}/dns_records/${encodeURIComponent(record.id)}`,
      { method: 'DELETE' },
    );
  }

  async waitForTxtPropagation(recordName: string, expectedValue: string): Promise<void> {
    const zoneName = deriveZoneName(recordName.replace(/^_acme-challenge\./, ''));
    const nameservers = await dns.resolveNs(zoneName);
    // A レコードを持たない NS が 1 本混ざるだけで Promise.all は全体を落とす。
    // 権威が 1 本でも引ければ伝播確認はできるので、引けたものだけ使う。
    const lookups = await Promise.allSettled(nameservers.map(async (nameserver) => dns.resolve4(nameserver)));
    const addresses = lookups.flatMap((lookup) => (lookup.status === 'fulfilled' ? lookup.value : []));
    if (addresses.length === 0) {
      throw new Error(`No authoritative DNS addresses found for ${zoneName}`);
    }

    const resolver = new Resolver();
    resolver.setServers(addresses);
    const deadline = Date.now() + this.propagationTimeoutMs;
    while (Date.now() < deadline) {
      try {
        const values = await resolver.resolveTxt(recordName);
        if (values.some((parts) => parts.join('') === expectedValue)) return;
      } catch {
        // The authoritative server can answer NXDOMAIN until Cloudflare has propagated the record.
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(`DNS-01 TXT record did not propagate within ${this.propagationTimeoutMs}ms`);
  }

  private async resolveZoneId(zoneName: string): Promise<string> {
    const zones = await this.request<ZoneRecord[]>(`/zones?name=${encodeURIComponent(zoneName)}`);
    const zone = zones.find((candidate) => candidate.name === zoneName);
    if (!zone) throw new Error(`Cloudflare zone was not found: ${zoneName}`);
    return zone.id;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${CLOUDFLARE_API_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.options.apiToken}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });
    // 5xx / WAF ブロックでは JSON でも errors でもない body が返る。ここで TypeError を
    // 投げると HTTP status という唯一の手がかりまで消える。
    const body = (await response.json().catch(() => null)) as CloudflareResult<T> | null;
    if (!response.ok || !body?.success) {
      const errors = body?.errors;
      const detail = Array.isArray(errors)
        ? errors.map((error) => error.message ?? 'unknown error').join(', ')
        : 'unparsable response body';
      throw new Error(`Cloudflare DNS request failed (${response.status}): ${detail}`);
    }
    return body.result;
  }
}
