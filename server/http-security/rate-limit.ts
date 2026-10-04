// LAN 向けの開始・照合系 API の IP 単位レート制限 (メモリ上の固定窓)。
//
// 単一ゲートウェイ前提なので in-memory で十分 (再起動で消えてよい)。共有 Wi-Fi 上の
// 端末からのパスワード総当たり・nonce/セッションの大量発行・kiosk の占有を抑える。
// 同一ホスト (loopback) の kiosk は顔フレームを毎秒数回送るので対象外にする。

import type { Context, MiddlewareHandler } from 'hono';

import { remoteAddressOf, transportOf, type RemoteAddressResolver } from './transport.ts';
import { contract } from '../contract-runtime.ts'; /* augur-inject:import:12bd3b68 */
import augurContract_2c9d2aba from '../../contracts/hit-rate-limit.contract.ts'; /* augur-inject:contract-predicate:3b519bcd */

export interface RateLimitPolicy {
  limit: number;
  windowMs: number;
}

export interface RateLimitBucket {
  windowStartedAt: number;
  count: number;
}

export type RateLimitBuckets = Map<string, RateLimitBucket>;

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitPolicy = { limit: 30, windowMs: 60_000 };

/** 1 回分の要求を数え、上限を超えたかを返す (C-18)。 */
export function hitRateLimit(buckets: RateLimitBuckets, key: string, now: number, policy: RateLimitPolicy): RateLimitResult {
  let bucket = buckets.get(key);
  if (!bucket || now < bucket.windowStartedAt || now - bucket.windowStartedAt >= policy.windowMs) {
    bucket = { windowStartedAt: now, count: 0 };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count <= policy.limit) return { allowed: true, retryAfterSec: 0 };
  return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((bucket.windowStartedAt + policy.windowMs - now) / 1000)) };
}
// @ts-expect-error augur-inject
hitRateLimit = contract(hitRateLimit, { ...augurContract_2c9d2aba, contractId: 'C-18', mode: 'observe', sample: 1, where: 'server/http-security/rate-limit.ts:31', rule: 'contract-wrap', id: '2c9d2aba' }); /* augur-inject:contract-wrap:2c9d2aba */

function sweep(buckets: RateLimitBuckets, now: number, windowMs: number): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStartedAt >= windowMs) buckets.delete(key);
  }
}

export interface RateLimitOptions {
  policy?: RateLimitPolicy;
  /** 対象にする要求か (method と path で決める)。 */
  applies: (c: Context) => boolean;
  resolveRemoteAddress?: RemoteAddressResolver;
  now?: () => number;
}

/** 上限超過は 429 rate_limited + Retry-After。 */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  const policy = options.policy ?? DEFAULT_RATE_LIMIT;
  const resolve = options.resolveRemoteAddress ?? remoteAddressOf;
  const now = options.now ?? Date.now;
  const buckets: RateLimitBuckets = new Map();
  let lastSweepAt = 0;

  return async (c, next) => {
    if (!options.applies(c) || transportOf(c, resolve) === 'loopback') return next();
    const at = now();
    if (at - lastSweepAt >= policy.windowMs) {
      sweep(buckets, at, policy.windowMs);
      lastSweepAt = at;
    }
    // アドレス不明はまとめて 1 つの bucket に入れる (別人扱いで上限を回避させない)。
    const result = hitRateLimit(buckets, resolve(c) ?? 'unknown', at, policy);
    if (!result.allowed) {
      return c.json({ error: 'rate_limited' }, 429, { 'retry-after': String(result.retryAfterSec) });
    }
    await next();
  };
}
