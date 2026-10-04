// 全応答に付ける防御ヘッダ (spec/feature/lan-https-and-lan-url.md §8)。
//
// - CSP: default-src 'self'。inline script は応答ごとの nonce でだけ許す ('unsafe-inline' を使わない)。
// - X-Frame-Options: DENY / X-Content-Type-Options: nosniff / Referrer-Policy: no-referrer。
// - Cache-Control: 応答が自分で決めていなければ no-store (認証系・個人データを中間に残さない)。
//
// HTML を返す route は `scriptNonce(c)` で nonce を取り出して `<script nonce="…">` に載せる。
// middleware は handler の後に同じ nonce で CSP を組むので、両者が食い違わない。

import { randomBytes } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { contract } from '../contract-runtime.ts'; /* augur-inject:import:b1c369ad */
import augurContract_210d37d4 from '../../contracts/build-security-headers.contract.ts'; /* augur-inject:contract-predicate:8b8e9eda */

const nonces = new WeakMap<Request, string>();

/** この要求の CSP nonce。初回呼び出しで生成し、同じ要求の中では同じ値を返す。 */
export function scriptNonce(c: Context): string {
  const existing = nonces.get(c.req.raw);
  if (existing) return existing;
  const nonce = randomBytes(16).toString('base64');
  nonces.set(c.req.raw, nonce);
  return nonce;
}

/** 防御ヘッダ一式 (C-20)。 */
export function buildSecurityHeaders(nonce: string): Record<string, string> {
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "media-src 'self' blob: mediastream:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');
  return {
    'content-security-policy': csp,
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
}
// @ts-expect-error augur-inject
buildSecurityHeaders = contract(buildSecurityHeaders, { ...augurContract_210d37d4, contractId: 'C-20', mode: 'observe', sample: 1, where: 'server/http-security/security-headers.ts:25', rule: 'contract-wrap', id: '210d37d4' }); /* augur-inject:contract-wrap:210d37d4 */

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(buildSecurityHeaders(scriptNonce(c)))) {
      c.res.headers.set(name, value);
    }
    if (!c.res.headers.has('cache-control')) c.res.headers.set('cache-control', 'no-store');
  };
}
