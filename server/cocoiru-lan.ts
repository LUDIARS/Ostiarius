// Cocoiru attendance trusts the socket's connected subnet, never client SSID claims.
import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { Context } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import { isPrivateAddress } from './face/lan-guard.ts';

const PROXY_HEADERS = ['forwarded', 'x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'cf-ray'];
const normalize = (address: string): string => address.replace(/^::ffff:/i, '').split('%')[0] ?? '';

/** The operator selects the venue interface; VPN/other interfaces cannot grant attendance. */
export function createCocoiruLanGuard(interfaceName: string): (c: Context) => boolean {
  return (c) => {
    if (PROXY_HEADERS.some((name) => c.req.raw.headers.has(name))) return false;
    const socket = (c.env as Partial<HttpBindings> | undefined)?.incoming?.socket;
    if (!socket?.remoteAddress || !socket.localAddress) return false;
    const remote = normalize(socket.remoteAddress);
    const local = normalize(socket.localAddress);
    if (!isPrivateAddress(remote) || !isPrivateAddress(local)) return false;
    const interfaces = networkInterfaces()[interfaceName] ?? [];
    return interfaces.some((entry) => {
      if (entry.internal || normalize(entry.address) !== local || !entry.cidr) return false;
      const family = isIP(local);
      if (!family || isIP(remote) !== family) return false;
      const prefix = Number(entry.cidr.split('/')[1]);
      if (!Number.isInteger(prefix) || prefix < 1 || prefix > (family === 4 ? 32 : 128)) return false;
      const subnet = new BlockList();
      subnet.addSubnet(local, prefix, family === 4 ? 'ipv4' : 'ipv6');
      return subnet.check(remote, family === 4 ? 'ipv4' : 'ipv6');
    });
  };
}
