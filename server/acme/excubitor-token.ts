import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TOKEN_KEY = 'CLOUDFLARE_DNS_API_TOKEN';
const VAULT_KEY = 'CLIENT_SECRET';

export interface SecretAgentDependencies {
  fetchImpl?: typeof fetch;
  readTokenFile?: (path: string) => Promise<string>;
}

/** Use Ex's authenticated secret-agent, never decrypt Vault or query another service. */
export async function resolveCloudflareToken(
  env: NodeJS.ProcessEnv = process.env, deps: SecretAgentDependencies = {},
): Promise<string> {
  const explicit = env[TOKEN_KEY]?.trim();
  if (explicit) return explicit;
  const endpoint = env.EXCUBITOR_URL?.trim();
  if (!endpoint) throw new Error('EXCUBITOR_URL is required to obtain the Cloudflare token from Excubitor');
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error('Invalid EXCUBITOR_URL'); }
  // Ex commonly injects localhost; pin it to loopback without a DNS lookup.
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('EXCUBITOR_URL must be a numeric loopback HTTP(S) origin');
  }
  let agentToken = env.EXCUBITOR_AGENT_TOKEN?.trim();
  if (!agentToken) {
    const path = env.EXCUBITOR_AGENT_TOKEN_PATH?.trim()
      || join(env.APPDATA || env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Excubitor', 'secret-agent.token');
    try { agentToken = (await (deps.readTokenFile ?? ((file) => readFile(file, 'utf8')))(path)).trim(); }
    catch { throw new Error('Cannot read the existing Excubitor agent token; check EXCUBITOR_AGENT_TOKEN_PATH'); }
  }
  if (!agentToken) throw new Error('Excubitor agent token is empty');
  let response: Response;
  try {
    response = await (deps.fetchImpl ?? fetch)(new URL('/api/v1/secrets/resolve', url), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'ostiarius-acme', keys: [VAULT_KEY] }),
    });
  } catch { throw new Error('Excubitor secret-agent connection failed; no fallback to Infisical'); }
  if (!response.ok) throw new Error(`Excubitor secret-agent returned HTTP ${response.status}; check Os Vault binding and agent authentication`);
  const body = await response.json().catch(() => null) as { source?: unknown; secrets?: Record<string, unknown> } | null;
  const token = body?.secrets?.[VAULT_KEY];
  if (body?.source !== 'vault' || typeof token !== 'string' || !token.trim()) {
    throw new Error('Excubitor did not return the required Os Vault token');
  }
  return token.trim();
}
