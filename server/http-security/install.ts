// HTTP の LAN 内サービスとしての防御を app へ組み込む (spec/feature/lan-https-and-lan-url.md §8)。
//
// 順序に意味がある:
//   1. 防御ヘッダ (最外周。拒否応答にも付ける)
//   2. Host 許可リスト (DNS リバインディング)
//   3. Origin 許可リスト (CORS / CSRF)
//   4. レート制限 (以降の検査で nonce を消費する前に数える)
//   5. 機微経路のガード (LAN 内 かつ TLS か loopback)
//   6. 要求 nonce (ここまで通った要求だけが nonce を消費する)
// route の mount はこの後に行う。

import type { Context, Hono } from 'hono';

import { createAllowedHostsResolver, hostAllowlist, type AllowedHosts } from './host-allowlist.ts';
import { isRateLimitedRoute, isSensitiveRoute, requiresRequestNonce } from './lan-routes.ts';
import { originAllowlist, type OriginScope } from './origin-allowlist.ts';
import { rateLimit, type RateLimitPolicy } from './rate-limit.ts';
import { makeRequestNonceRouter, RequestNonceStore, requireRequestNonce } from './request-nonce.ts';
import { securityHeaders } from './security-headers.ts';
import { sensitiveRouteGuard } from './sensitive-route-guard.ts';
import type { RemoteAddressResolver } from './transport.ts';

export interface LanHardeningOptions {
  port: number;
  lanHostname?: string;
  /** どの scope にも入らない path の CORS allowlist (PWA の origin)。 */
  corsOrigins: readonly string[];
  /** 専用 CORS を持つ router の scope (現地確認 MFA の Cernere origin)。 */
  corsScopes?: readonly OriginScope[];
  isLan: (c: Context) => boolean;
  /** テスト用の差し替え口。 */
  allowedHosts?: () => AllowedHosts;
  resolveRemoteAddress?: RemoteAddressResolver;
  rateLimitPolicy?: RateLimitPolicy;
  nonces?: RequestNonceStore;
}

export function installLanHardening(app: Hono, options: LanHardeningOptions): { nonces: RequestNonceStore } {
  const nonces = options.nonces ?? new RequestNonceStore();
  app.use('*', securityHeaders());
  app.use('*', hostAllowlist(options.allowedHosts ?? createAllowedHostsResolver({ port: options.port, lanHostname: options.lanHostname })));
  app.use('*', originAllowlist({ scopes: options.corsScopes ?? [], defaultOrigins: options.corsOrigins }));
  app.use('*', rateLimit({ applies: isRateLimitedRoute, policy: options.rateLimitPolicy, resolveRemoteAddress: options.resolveRemoteAddress }));
  app.use('*', sensitiveRouteGuard({ applies: isSensitiveRoute, isLan: options.isLan, resolveRemoteAddress: options.resolveRemoteAddress }));
  app.use('*', requireRequestNonce(nonces, requiresRequestNonce));
  app.route('/', makeRequestNonceRouter(nonces));
  return { nonces };
}
