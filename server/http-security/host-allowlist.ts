// DNS リバインディング対策の Host ヘッダ検査。
//
// 攻撃者のドメインを会場 LAN の IP へ向け直されると、ブラウザはそのページから Ostiarius へ
// 「同一 origin」として要求を送れてしまう。Host ヘッダが Ostiarius 自身の名前でなければ断る。
//
// 許可する名前: 検出した LAN IPv4 (このホストの非 internal な IPv4 全部)、localhost /
// 127.0.0.1 / [::1]、OSTIARIUS_LAN_HOSTNAME (設定時)。port は省略か待受 port のみ。

import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import type { Context, MiddlewareHandler } from 'hono';
import { contract } from '../contract-runtime.ts'; /* augur-inject:import:011eef4c */
import augurContract_c4bab8b2 from '../../contracts/is-allowed-host.contract.ts'; /* augur-inject:contract-predicate:07b48943 */

export interface AllowedHosts {
  names: ReadonlySet<string>;
  port: number;
}

const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '[::1]'];
const REFRESH_MS = 60_000;

function splitHost(host: string): { name: string; port: string } | null {
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(host);
  if (bracketed) return { name: `[${bracketed[1]!.toLowerCase()}]`, port: bracketed[2] ?? '' };
  const plain = /^([^:\s]+)(?::(\d+))?$/.exec(host);
  return plain ? { name: plain[1]!.toLowerCase(), port: plain[2] ?? '' } : null;
}

/** Host ヘッダが許可リストに入るか (C-16)。 */
export function isAllowedHost(host: string | undefined, allowed: AllowedHosts): boolean {
  if (!host) return false;
  const parsed = splitHost(host.trim());
  if (!parsed || !allowed.names.has(parsed.name)) return false;
  return parsed.port === '' || parsed.port === String(allowed.port);
}
// @ts-expect-error augur-inject
isAllowedHost = contract(isAllowedHost, { ...augurContract_c4bab8b2, contractId: 'C-16', mode: 'observe', sample: 1, where: 'server/http-security/host-allowlist.ts:28', rule: 'contract-wrap', id: 'c4bab8b2' }); /* augur-inject:contract-wrap:c4bab8b2 */

/** このホストに割り当たっている LAN 側 IPv4 (internal を除く)。 */
export function localIpv4Addresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string[] {
  return Object.values(interfaces)
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}

export interface HostAllowlistOptions {
  port: number;
  lanHostname?: string;
  /** テスト用: LAN IPv4 の検出を差し替える。 */
  detectAddresses?: () => string[];
  now?: () => number;
}

/** 会場の接続先は日によって変わるので、検出結果を短く cache して作り直す。 */
export function createAllowedHostsResolver(options: HostAllowlistOptions): () => AllowedHosts {
  const detect = options.detectAddresses ?? (() => localIpv4Addresses());
  const now = options.now ?? Date.now;
  let cached: { value: AllowedHosts; expiresAt: number } | undefined;
  return () => {
    if (cached && now() < cached.expiresAt) return cached.value;
    const names = new Set([...LOOPBACK_NAMES, ...detect()]);
    if (options.lanHostname) names.add(options.lanHostname.toLowerCase());
    cached = { value: { names, port: options.port }, expiresAt: now() + REFRESH_MS };
    return cached.value;
  };
}

/**
 * 要求の Host。node-server は Host ヘッダから URL を組むので通常は同じ値になる。
 * ヘッダを持たない実行環境 (単体テストの `app.request()`) では URL の host を使う。
 */
export function requestHost(c: Context): string {
  return c.req.header('host') ?? new URL(c.req.url).host;
}

/** 許可外の Host は 421 misdirected_host で断る (応答本文に許可リストを出さない)。 */
export function hostAllowlist(resolve: () => AllowedHosts): MiddlewareHandler {
  return async (c, next) => {
    if (!isAllowedHost(requestHost(c), resolve())) {
      return c.json({ error: 'misdirected_host' }, 421);
    }
    await next();
  };
}
