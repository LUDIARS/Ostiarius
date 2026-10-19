import { loadLanDnsConfig } from './config.ts';
import { selectLanDnsAddress } from './address.ts';
import { syncCloudflareLanDns, type DnsSyncResult } from './cloudflare.ts';

/** Runs before allocating server resources; failure prevents advertising a stale LAN route. */
export async function updateStartupLanDns(env: NodeJS.ProcessEnv = process.env): Promise<DnsSyncResult | 'off'> {
  const config = loadLanDnsConfig(env);
  if (!config) return 'off';
  return syncCloudflareLanDns(config, selectLanDnsAddress(config.interfaceName));
}
