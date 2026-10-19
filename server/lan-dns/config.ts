export interface LanDnsConfig {
  hostname: string;
  zoneId: string;
  apiToken: string;
  interfaceName: string;
}

export function loadLanDnsConfig(env: NodeJS.ProcessEnv = process.env): LanDnsConfig | null {
  const mode = env.OSTIARIUS_LAN_DNS_MODE ?? 'off';
  if (mode === 'off') return null;
  if (mode !== 'cloudflare') throw new Error('Invalid OSTIARIUS_LAN_DNS_MODE');
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required for LAN DNS updates`);
    return value;
  };
  const hostname = required('OSTIARIUS_LAN_HOSTNAME').toLowerCase();
  if (hostname.length > 253 || !hostname.includes('.') || !hostname.split('.').every(
    (label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
  )) throw new Error('Invalid OSTIARIUS_LAN_HOSTNAME');
  const zoneId = required('OSTIARIUS_LAN_DNS_ZONE_ID');
  if (!/^[a-f0-9]{32}$/i.test(zoneId)) throw new Error('Invalid OSTIARIUS_LAN_DNS_ZONE_ID');
  return {
    hostname, zoneId,
    apiToken: required('CLOUDFLARE_DNS_API_TOKEN'),
    interfaceName: required('OSTIARIUS_LAN_DNS_INTERFACE'),
  };
}
