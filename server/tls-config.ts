import { contract } from '../contract-runtime.ts'; /* augur-inject:import:e86e0333 */
import augurContract_96a25a8f from '../contracts/resolve-tls-config.contract.ts'; /* augur-inject:contract-predicate:43deb7be */
export type OstiariusTlsConfig =
  | { enabled: false }
  | {
      enabled: true;
      hostname: string;
      certificatePem: string;
      privateKeyPem: string;
    };

function value(env: NodeJS.ProcessEnv, key: string): string {
  return env[key]?.trim() ?? '';
}

const DNS_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DNS_HOSTNAME_PATTERN = new RegExp(`^(?=.{1,253}$)(?:${DNS_LABEL}\\.)*${DNS_LABEL}$`, 'i');

/** TLSを明示的に有効化した場合だけ、必要な3値をfail-fastで検証する。 */
export function resolveTlsConfig(env: NodeJS.ProcessEnv = process.env): OstiariusTlsConfig {
  const mode = value(env, 'OSTIARIUS_TLS_MODE') || 'off';
  if (mode === 'off') return { enabled: false };
  if (mode !== 'required') {
    throw new Error('OSTIARIUS_TLS_MODE must be "off" or "required"');
  }

  const hostname = value(env, 'OSTIARIUS_LAN_HOSTNAME');
  const certificatePem = value(env, 'OSTIARIUS_TLS_CERTIFICATE_PEM');
  const privateKeyPem = value(env, 'OSTIARIUS_TLS_PRIVATE_KEY_PEM');
  const missing = [
    ['OSTIARIUS_LAN_HOSTNAME', hostname],
    ['OSTIARIUS_TLS_CERTIFICATE_PEM', certificatePem],
    ['OSTIARIUS_TLS_PRIVATE_KEY_PEM', privateKeyPem],
  ].filter(([, configured]) => !configured).map(([key]) => key);
  if (missing.length > 0) {
    throw new Error(`Ostiarius TLS configuration is incomplete: missing ${missing.join(', ')}`);
  }
  if (!DNS_HOSTNAME_PATTERN.test(hostname)) {
    throw new Error('OSTIARIUS_LAN_HOSTNAME must be a DNS hostname without a scheme, port, or path');
  }

  return { enabled: true, hostname, certificatePem, privateKeyPem };
}
// @ts-expect-error augur-inject
resolveTlsConfig = contract(resolveTlsConfig, { ...augurContract_96a25a8f, contractId: 'C-7', mode: 'observe', sample: 1, where: 'server/tls-config.ts:18', rule: 'contract-wrap', id: '96a25a8f' }); /* augur-inject:contract-wrap:96a25a8f */
