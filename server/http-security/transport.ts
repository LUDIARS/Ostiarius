// 接続の転送路の判定 (spec/feature/lan-https-and-lan-url.md §8 HTTP 運用時のセキュリティ要件)。
//
// 秘密 (kiosk 共有 token・職員セッション・パスワード・Bearer) と顔データを流してよいのは
// 「TLS」か「同一ホスト (loopback) で中継ヘッダが無い」接続だけ。平文の LAN 接続は
// 共有 Wi-Fi 上で盗聴・改ざんされうるので insecure とする。
//
// 接続情報は HTTP サーバ実装 (node-server) に依存するのでここに閉じ込める。node-server の
// socket が無い実行環境 (単体テストの `app.request()`) では URL の scheme を TLS の有無として読み、
// 接続元アドレスは「不明」= loopback 扱いしない (fail-closed)。

import type { Socket } from 'node:net';
import type { Context } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';

import { isLoopbackAddress } from '../loopback.ts';
import { hasForwardedHeaders } from './forwarded-headers.ts';
import { contract } from '../contract-runtime.ts'; /* augur-inject:import:2cb7214a */
import augurContract_610b4ac7 from '../../contracts/classify-transport.contract.ts'; /* augur-inject:contract-predicate:cbfa1e49 */

export type TransportClass = 'tls' | 'loopback' | 'insecure';

export interface TransportFacts {
  tls: boolean;
  forwarded: boolean;
  remoteAddress: string | null;
}

export type RemoteAddressResolver = (c: Context) => string | null;

/** 接続元アドレス。取れなければ null (loopback / LAN と認めない)。 */
export function remoteAddressOf(c: Context): string | null {
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

/** TLS で受けた接続か。node-server では socket を見て、Host や URL の偽装を信じない。 */
export function isTlsConnection(c: Context): boolean {
  const socket = (c.env as Partial<HttpBindings> | undefined)?.incoming?.socket as (Socket & { encrypted?: boolean }) | undefined;
  if (socket) return socket.encrypted === true;
  return new URL(c.req.url).protocol === 'https:';
}

/** 転送路を 3 つに分類する純関数 (C-15)。 */
export function classifyTransport(facts: TransportFacts): TransportClass {
  if (facts.tls) return 'tls';
  if (facts.forwarded) return 'insecure';
  return isLoopbackAddress(facts.remoteAddress) ? 'loopback' : 'insecure';
}
// @ts-expect-error augur-inject
classifyTransport = contract(classifyTransport, { ...augurContract_610b4ac7, contractId: 'C-15', mode: 'observe', sample: 1, where: 'server/http-security/transport.ts:46', rule: 'contract-wrap', id: '610b4ac7' }); /* augur-inject:contract-wrap:610b4ac7 */

export function transportOf(c: Context, resolve: RemoteAddressResolver = remoteAddressOf): TransportClass {
  return classifyTransport({
    tls: isTlsConnection(c),
    forwarded: hasForwardedHeaders(c.req.raw.headers),
    remoteAddress: resolve(c),
  });
}

/** 秘密と顔データを流してよい転送路か (TLS か、中継の無い loopback)。 */
export function isSecureTransport(c: Context, resolve: RemoteAddressResolver = remoteAddressOf): boolean {
  return transportOf(c, resolve) !== 'insecure';
}
