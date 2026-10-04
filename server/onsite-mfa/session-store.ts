// 現地確認 MFA のセッション (spec/feature/onsite-mfa-factor.md §2.1)。
//
// 利用者端末が施設 LAN 経由で届けた nonce を 1 件だけ保持し、kiosk 画面の「確認待ち」と
// 端末向けの状態参照に使う。外部状態は持たず、再起動時は安全に失効する。
//
// - 1 kiosk (= この Ostiarius) で同時に有効なセッションは 1 件だけ。2 件目は kiosk_busy。
//   待ち行列にしないのは、kiosk の前に立つ人と nonce の対応を画面上で取り違えないため。
// - 期限は Cernere の ticket と同じ 5 分。期限切れのセッションは kiosk を塞がない。
// - 端末から受け取るのは nonce だけ。userId や操作内容は持たない。

import { randomUUID } from 'node:crypto';
import { contract } from '../contract-runtime.ts'; /* augur-inject:import:7bdd76bf */
import augurContract_1986eac7 from '../../contracts/open-onsite-mfa-session.contract.ts'; /* augur-inject:contract-predicate:75f1c0d4 */

export const ONSITE_MFA_SESSION_TTL_MS = 5 * 60_000;

/** 端末表示用の状態 (契約 E)。 */
export type OnsiteMfaState = 'waiting' | 'submitted' | 'rejected' | 'expired';

export interface OnsiteMfaView {
  state: OnsiteMfaState;
  error?: string;
}

/** 内部状態。submitting は Cernere へ送信中 (端末には waiting と見せる)。 */
type InternalState = 'waiting' | 'submitting' | 'submitted' | 'rejected';

export interface OnsiteMfaSession {
  sessionId: string;
  nonce: string;
  expiresAt: number;
  state: InternalState;
  error?: string;
}

export interface OnsiteMfaSessionStoreOptions {
  ttlMs?: number;
  /** 終了・期限切れのセッションを状態参照用に残す時間。 */
  retentionMs?: number;
  now?: () => number;
}

export class OnsiteMfaSessionStore {
  private readonly sessions = new Map<string, OnsiteMfaSession>();
  private readonly ttlMs: number;
  private readonly retentionMs: number;
  readonly now: () => number;

  constructor(options: OnsiteMfaSessionStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? ONSITE_MFA_SESSION_TTL_MS;
    this.retentionMs = options.retentionMs ?? this.ttlMs;
    this.now = options.now ?? Date.now;
  }

  /** 確認待ち (送信中を含む) で期限内のセッション。kiosk 画面と排他判定に使う。 */
  active(): OnsiteMfaSession | null {
    this.sweep();
    for (const session of this.sessions.values()) {
      if (session.state === 'submitting') return session;
      if (session.state === 'waiting' && session.expiresAt > this.now()) return session;
    }
    return null;
  }

  /** 排他判定は呼び出し側 (openOnsiteMfaSession) の責務。 */
  create(nonce: string): OnsiteMfaSession {
    const session: OnsiteMfaSession = {
      sessionId: randomUUID(),
      nonce,
      expiresAt: this.now() + this.ttlMs,
      state: 'waiting',
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  view(sessionId: string): OnsiteMfaView | null {
    this.sweep();
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (session.state === 'submitting') return { state: 'waiting' };
    if (session.state === 'waiting') return session.expiresAt > this.now() ? { state: 'waiting' } : { state: 'expired' };
    return session.error ? { state: session.state, error: session.error } : { state: session.state };
  }

  /** 期限内の確認待ちセッションを送信中にする。二重送信を防ぐため 1 回だけ成功する。 */
  claim(sessionId: string): OnsiteMfaSession | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.state !== 'waiting' || session.expiresAt <= this.now()) return null;
    session.state = 'submitting';
    return session;
  }

  /** 送信結果を記録する。送信中でなければ何もしない。 */
  settle(sessionId: string, outcome: { state: 'submitted' } | { state: 'rejected'; error: string }): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.state !== 'submitting') return;
    session.state = outcome.state;
    session.error = outcome.state === 'rejected' ? outcome.error : undefined;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (session.state !== 'submitting' && session.expiresAt + this.retentionMs <= now) this.sessions.delete(id);
    }
  }
}

export type OpenOnsiteMfaResult = { sessionId: string; expiresAt: number } | { error: 'kiosk_busy' };

/** 確認待ちを 1 件だけ開く。既に有効なセッションがあれば kiosk_busy。 */
export function openOnsiteMfaSession(store: OnsiteMfaSessionStore, nonce: string): OpenOnsiteMfaResult {
  if (store.active()) return { error: 'kiosk_busy' };
  const session = store.create(nonce);
  return { sessionId: session.sessionId, expiresAt: session.expiresAt };
}
// @ts-expect-error augur-inject
openOnsiteMfaSession = contract(openOnsiteMfaSession, { ...augurContract_1986eac7, contractId: 'C-12', mode: 'observe', sample: 1, where: 'server/onsite-mfa/session-store.ts:111', rule: 'contract-wrap', id: '1986eac7' }); /* augur-inject:contract-wrap:1986eac7 */
