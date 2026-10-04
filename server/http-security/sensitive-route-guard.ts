// 秘密と顔データの経路を「施設 LAN 内 かつ TLS か loopback」に限る middleware。
//
// 平文の LAN では職員セッション token・パスワード・顔フレームが盗聴できてしまう。
// HTTP 運用中 (TLS 未導入) は kiosk 本体 (loopback) からだけ使える。理由コードは固定:
//   403 lan_only                  … 施設 LAN の外 (中継ヘッダ付き・公開アドレス)
//   403 secure_transport_required … LAN 内だが平文 HTTP の別端末

import type { Context, MiddlewareHandler } from 'hono';

import type { RemoteAddressResolver } from './transport.ts';
import { isSecureTransport, remoteAddressOf } from './transport.ts';

export interface SensitiveRouteGuardOptions {
  applies: (c: Context) => boolean;
  isLan: (c: Context) => boolean;
  resolveRemoteAddress?: RemoteAddressResolver;
}

export function sensitiveRouteGuard(options: SensitiveRouteGuardOptions): MiddlewareHandler {
  const resolve = options.resolveRemoteAddress ?? remoteAddressOf;
  return async (c, next) => {
    if (!options.applies(c) || c.req.method === 'OPTIONS') return next();
    if (!options.isLan(c)) return c.json({ error: 'lan_only' }, 403);
    if (!isSecureTransport(c, resolve)) return c.json({ error: 'secure_transport_required' }, 403);
    await next();
  };
}
