// 状態を変える LAN 向け API のリプレイ対策 (サーバ発行・短命・一回限りの nonce)。
//
//   POST /api/lan/nonce  -> { nonce, expiresAt }   (応答は no-store)
//   以後の要求に `x-ostiarius-nonce: <nonce>` を付ける。サーバは受け取った時点で消費する。
//
// 盗聴した要求をそのまま再送しても nonce が使用済みなので通らない。保存は既存の
// ChallengeStore (TTL 付き・consume で 1 回だけ) を使う。

import { randomBytes } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';

import { ChallengeStore } from '../challenge-store.ts';
import { contract } from '../contract-runtime.ts'; /* augur-inject:import:d3b9909e */
import augurContract_c88b7782 from '../../contracts/consume-request-nonce.contract.ts'; /* augur-inject:contract-predicate:35ab6e35 */

export const REQUEST_NONCE_HEADER = 'x-ostiarius-nonce';
export const REQUEST_NONCE_PATH = '/api/lan/nonce';
export const REQUEST_NONCE_TTL_MS = 3 * 60_000;

export type RequestNonceOutcome = 'accepted' | 'missing' | 'rejected';

/** 発行済みで未使用の nonce を持つストア。ChallengeStore に「残っているか」を足しただけ。 */
export class RequestNonceStore {
  private readonly store: ChallengeStore;
  private readonly outstanding = new Map<string, number>();

  constructor(ttlMs = REQUEST_NONCE_TTL_MS) {
    this.store = new ChallengeStore(ttlMs);
  }

  issue(): { nonce: string; expiresAt: number } {
    this.store.sweep();
    this.pruneOutstanding();
    const nonce = randomBytes(32).toString('base64url');
    const expiresAt = this.store.put(nonce);
    this.outstanding.set(nonce, expiresAt);
    return { nonce, expiresAt };
  }

  /** 1 回だけ true。期限切れ・未発行・使用済みは false。 */
  consume(nonce: string): boolean {
    this.outstanding.delete(nonce);
    return this.store.consume(nonce);
  }

  isOutstanding(nonce: string): boolean {
    const expiresAt = this.outstanding.get(nonce);
    return expiresAt !== undefined && expiresAt >= Date.now();
  }

  /** ChallengeStore の sweep と同じ基準で、期限切れの控えを捨てる。 */
  private pruneOutstanding(): void {
    const now = Date.now();
    for (const [nonce, expiresAt] of this.outstanding) {
      if (expiresAt < now) this.outstanding.delete(nonce);
    }
  }
}

/** nonce を検査して消費する (C-19)。 */
export function consumeRequestNonce(store: RequestNonceStore, nonce: string | undefined): RequestNonceOutcome {
  if (!nonce) return 'missing';
  return store.consume(nonce) ? 'accepted' : 'rejected';
}
// @ts-expect-error augur-inject
consumeRequestNonce = contract(consumeRequestNonce, { ...augurContract_c88b7782, contractId: 'C-19', mode: 'observe', sample: 1, where: 'server/http-security/request-nonce.ts:60', rule: 'contract-wrap', id: 'c88b7782' }); /* augur-inject:contract-wrap:c88b7782 */

/** nonce の発行口。 */
export function makeRequestNonceRouter(store: RequestNonceStore): Hono {
  const router = new Hono();
  router.post(REQUEST_NONCE_PATH, (c) => {
    c.header('cache-control', 'no-store');
    return c.json(store.issue());
  });
  return router;
}

/** 対象の要求に nonce を必須にする。欠落は 400 nonce_required、無効は 409 nonce_rejected。 */
export function requireRequestNonce(store: RequestNonceStore, applies: (c: Context) => boolean): MiddlewareHandler {
  return async (c, next) => {
    if (!applies(c)) return next();
    const outcome = consumeRequestNonce(store, c.req.header(REQUEST_NONCE_HEADER));
    if (outcome === 'missing') return c.json({ error: 'nonce_required' }, 400);
    if (outcome === 'rejected') return c.json({ error: 'nonce_rejected' }, 409);
    await next();
  };
}
