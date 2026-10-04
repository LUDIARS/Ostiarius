// 顔写真の取得を **施設 LAN 内** に限る認可境界。
//
// spec/plan/biometric-data-policy.md §5: 写真取得は LAN 内 + 職員セッション必須で、
// 施設外 (Cloudflare Tunnel 等) へこの経路を公開しない。職員セッションだけでは
// 「トンネル越しに職員 token を持ち出されたら施設外から写真が見える」ので、
// 接続元も見る。
//
// 判定は 2 つ:
//   1. 接続元アドレスが loopback / private range であること
//   2. 逆プロキシ・トンネルを示すヘッダが無いこと (あれば施設外からの中継とみなす)
//
// アドレスを取れない実行環境 (node-server 以外) では **通さない** (fail-closed)。
// テストは resolver を差し替えて LAN 内/外を作る。
//
// HTTP 運用 (TLS 未導入) では、LAN 内でも平文の別端末へ写真・テンプレートを流さない。
// その経路には createSecureLanGuard (「TLS か loopback」を足した判定) を使う。

import type { Context } from 'hono';
import { isLoopbackAddress } from '../loopback.ts';
import { hasForwardedHeaders as hasForwardedRequestHeaders } from '../http-security/forwarded-headers.ts';
import { isSecureTransport, remoteAddressOf, type RemoteAddressResolver } from '../http-security/transport.ts';

export type { RemoteAddressResolver };

function normalize(address: string): string {
  const trimmed = address.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  const withoutZone = trimmed.split('%')[0] ?? '';
  return withoutZone.startsWith('::ffff:') ? withoutZone.slice('::ffff:'.length) : withoutZone;
}

/** RFC1918 / リンクローカル / ユニークローカル / loopback なら true。 */
export function isPrivateAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  if (isLoopbackAddress(address)) return true;
  const candidate = normalize(address);
  const octets = candidate.split('.');
  if (octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)) {
    const first = Number(octets[0]);
    const second = Number(octets[1]);
    if (first === 10) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 192 && second === 168) return true;
    if (first === 169 && second === 254) return true;
    return false;
  }
  // IPv6: fc00::/7 (unique local) と fe80::/10 (link local)。
  return /^f[cd][0-9a-f]{2}:/.test(candidate) || /^fe[89ab][0-9a-f]:/.test(candidate);
}

/** 中継ヘッダが付いていれば施設外扱い (一覧は http-security/forwarded-headers.ts)。 */
export function hasForwardedHeaders(c: Context): boolean {
  return hasForwardedRequestHeaders(c.req.raw.headers);
}

/** LAN 内判定。resolver を差し替えられるのはテストと将来の別実装のため。 */
export function createLanGuard(resolve: RemoteAddressResolver = remoteAddressOf): (c: Context) => boolean {
  return (c) => !hasForwardedHeaders(c) && isPrivateAddress(resolve(c));
}

/** 写真・テンプレート・登録系の判定: LAN 内 かつ 転送路が TLS か loopback。 */
export function createSecureLanGuard(resolve: RemoteAddressResolver = remoteAddressOf): (c: Context) => boolean {
  const isLan = createLanGuard(resolve);
  return (c) => isLan(c) && isSecureTransport(c, resolve);
}
