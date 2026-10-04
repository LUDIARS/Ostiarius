// C-16 isAllowedHost(host, allowed)
//
// DNS リバインディング対策。許可するのは allowlist の名前で、port は省略か待受 port だけ。

import type { AllowedHosts } from '../server/http-security/host-allowlist.ts';

function split(host: string): { name: string; port: string } | null {
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(host);
  if (bracketed) return { name: `[${bracketed[1]!.toLowerCase()}]`, port: bracketed[2] ?? '' };
  const plain = /^([^:\s]+)(?::(\d+))?$/.exec(host);
  return plain ? { name: plain[1]!.toLowerCase(), port: plain[2] ?? '' } : null;
}

export default {
  post: (result: boolean, host: string | undefined, allowed: AllowedHosts) => {
    const parsed = host ? split(host.trim()) : null;
    const expected = Boolean(parsed && allowed.names.has(parsed.name) && (parsed.port === '' || parsed.port === String(allowed.port)));
    return result === expected || (expected ? 'an allow-listed host was rejected' : 'a host outside the allowlist was accepted');
  },
};
