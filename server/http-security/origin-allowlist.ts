// CORS は明示した Origin の許可リストだけ (spec/feature/lan-https-and-lan-url.md §8)。
//
// - ワイルドカード (`*`) や origin でない値は設定の段階で拒否する (起動を止める)。
// - 許可外の Origin を持つ要求は preflight も本要求も 403 origin_not_allowed で断る
//   (CORS ヘッダを返さないだけだと、単純要求の副作用はサーバ側で起きてしまう)。
// - 同一 origin (Origin の host が要求の Host と一致) は CORS の対象外なので通す。
// - 資格情報 (cookie) 付きの CORS は許可しない (Access-Control-Allow-Credentials を返さない)。
//   kiosk cookie は同一 origin の画面だけが使う。

import type { Context, MiddlewareHandler } from 'hono';

import { requestHost } from './host-allowlist.ts';
import { contract } from '../contract-runtime.ts'; /* augur-inject:import:9dc32c20 */
import augurContract_4566e327 from '../../contracts/resolve-allowed-origin.contract.ts'; /* augur-inject:contract-predicate:b6bdc49a */

export interface OriginScope {
  pathPrefix: string;
  origins: readonly string[];
  /** 'router' は専用の CORS を持つ router (現地確認 MFA) にヘッダ付与を任せる。 */
  corsHeaders: 'self' | 'router';
}

export interface OriginPolicy {
  /** 最初に prefix が一致した scope の allowlist を使う。 */
  scopes: readonly OriginScope[];
  /** どの scope にも入らない path の allowlist。 */
  defaultOrigins: readonly string[];
  allowMethods?: readonly string[];
  allowHeaders?: readonly string[];
}

/** 許可リストに完全一致した Origin だけを返す (C-17)。 */
export function resolveAllowedOrigin(origin: string | undefined, allowlist: readonly string[]): string | null {
  if (!origin || origin === '*' || origin === 'null') return null;
  return allowlist.includes(origin) ? origin : null;
}
// @ts-expect-error augur-inject
resolveAllowedOrigin = contract(resolveAllowedOrigin, { ...augurContract_4566e327, contractId: 'C-17', mode: 'observe', sample: 1, where: 'server/http-security/origin-allowlist.ts:31', rule: 'contract-wrap', id: '4566e327' }); /* augur-inject:contract-wrap:4566e327 */

/** 許可リストにワイルドカードや origin でない値が混ざっていたら起動を止める。 */
export function assertOriginAllowlist(origins: readonly string[]): void {
  for (const origin of origins) {
    if (origin.includes('*')) throw new Error('CORS allowlist must not contain a wildcard');
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`CORS allowlist entry is not an origin: ${origin}`);
    }
    if (parsed.origin !== origin) throw new Error(`CORS allowlist entry must be a bare origin: ${origin}`);
  }
}

function isSameOrigin(c: Context, origin: string): boolean {
  try {
    return new URL(origin).host === requestHost(c);
  } catch {
    return false;
  }
}

export function originAllowlist(policy: OriginPolicy): MiddlewareHandler {
  for (const scope of policy.scopes) assertOriginAllowlist(scope.origins);
  assertOriginAllowlist(policy.defaultOrigins);
  const allowMethods = (policy.allowMethods ?? ['GET', 'POST', 'OPTIONS']).join(', ');
  const allowHeaders = (policy.allowHeaders ?? ['content-type', 'authorization', 'x-ostiarius-nonce']).join(', ');

  return async (c, next) => {
    const origin = c.req.header('origin');
    if (!origin || isSameOrigin(c, origin)) return next();
    const scope = policy.scopes.find((entry) => c.req.path.startsWith(entry.pathPrefix));
    const allowed = resolveAllowedOrigin(origin, scope?.origins ?? policy.defaultOrigins);
    if (!allowed) return c.json({ error: 'origin_not_allowed' }, 403);
    if (scope?.corsHeaders === 'router') return next();
    if (c.req.method === 'OPTIONS') {
      return c.body(null, 204, {
        'access-control-allow-origin': allowed,
        'access-control-allow-methods': allowMethods,
        'access-control-allow-headers': allowHeaders,
        'access-control-max-age': '600',
        vary: 'Origin',
      });
    }
    await next();
    c.res.headers.set('access-control-allow-origin', allowed);
    c.res.headers.append('vary', 'Origin');
  };
}
