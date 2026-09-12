// Augur `contract-wrap` の観測ランタイム (このリポ内の shim)。
//
// `augur.contracts.json` の `importFrom` がこのモジュールを指す。注入された
// ラッパは受け入れ条件 (契約) を実行時に観測するだけで、対象関数の戻り値・
// 例外・同期非同期性を変えない。`@ludiars/log-weaver` を kiosk の依存へ足さない
// ために最小実装をここに置く (Revisor `src/contract-runtime.mjs` と同じ位置づけ)。
//
// 記録先は Vestigium 互換の JSONL (`{time, msg, ctx}`) で、`augur contracts report`
// の既定解決先 (`VESTIGIUM_LOGS_DIR` → `<project>/logs`) に合わせる。
//
// **ctx に載せてよいのは契約 id / 位置 / 述語が返した分類文字列だけ。**
// 引数・戻り値・テンプレート・写真・氏名は載せない (biometric-data-policy §5)。
//
// `mode: 'enforce'` は受け取っても制御フローを変えない (観測に徹する) — kiosk の
// 出席経路を観測目的で落とさないため。違反は JSONL に残り report が拾う。

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** 述語の戻り: `true`/`undefined` で合格、`false` か理由文字列で違反。 */
export type ContractVerdict = boolean | string | undefined | void;

export interface ContractPredicates {
  pre?: (...args: never[]) => ContractVerdict;
  post?: (result: never, ...args: never[]) => ContractVerdict;
  postThrow?: (error: unknown, ...args: never[]) => ContractVerdict;
}

export interface ContractSpec extends ContractPredicates {
  contractId: string;
  /** 注入マーカー id (augur inject が埋める)。 */
  id?: string;
  /** `file:line` — 注入位置。 */
  where?: string;
  rule?: string;
  mode?: 'observe' | 'enforce';
  sample?: number;
}

type AnyFunction = (this: unknown, ...args: never[]) => unknown;

/**
 * 合格の観測は契約ごとに間引く (既定 60 秒)。
 *
 * `sample` は 1 のまま (= 述語は毎回評価する) で、JSONL へ書く「観測できた」行だけを
 * 抑える。初回は必ず書くので `covered` / `not-called` の区別は失われない。
 * kiosk は 1 秒に数回 roster を組み直すので、間引かないとログが実運用で膨れる。
 */
const OBSERVED_INTERVAL_MS = 60_000;
const lastObservedAt = new Map<string, number>();

function logsDirectory(): string {
  const configured = process.env.VESTIGIUM_LOGS_DIR?.trim();
  return configured ? configured : join(process.cwd(), 'logs');
}

function record(message: string, context: Record<string, unknown>): void {
  try {
    const directory = logsDirectory();
    mkdirSync(directory, { recursive: true });
    appendFileSync(
      join(directory, 'contracts.jsonl'),
      `${JSON.stringify({ time: new Date().toISOString(), msg: message, ctx: context })}\n`,
      'utf8',
    );
  } catch {
    // 観測がラップ対象の動作を変えてはならない。
  }
}

/** 述語の戻りを「違反理由」または null に正規化する。 */
function reasonOf(verdict: ContractVerdict): string | null {
  if (verdict === true || verdict === undefined || verdict === null) return null;
  if (verdict === false) return 'predicate failed';
  return typeof verdict === 'string' ? verdict : null;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | null)?.then === 'function';
}

function observed(spec: ContractSpec, context: Record<string, unknown>): void {
  const now = Date.now();
  const previous = lastObservedAt.get(spec.contractId);
  if (previous !== undefined && now - previous < OBSERVED_INTERVAL_MS) return;
  lastObservedAt.set(spec.contractId, now);
  record('contract observed', { ...context, phase: 'ok' });
}

/** 契約 id ごとの観測間引きを忘れる (テストが同一プロセスで複数回観測するため)。 */
export function resetContractObservation(): void {
  lastObservedAt.clear();
}

/**
 * 受け入れ条件の述語で関数をラップする。
 *
 * 戻り値・例外・同期/非同期はそのまま通す。述語自身が throw した場合は
 * `contract predicate threw` として記録し、合格扱いにしない。
 */
export function contract<F extends AnyFunction>(fn: F, spec: ContractSpec): F {
  const context = { contract: spec.contractId, id: spec.id, where: spec.where, rule: spec.rule };
  const evaluate = (phase: 'pre' | 'post' | 'postThrow', verdict: () => ContractVerdict): string | null => {
    try {
      return reasonOf(verdict());
    } catch {
      record('contract predicate threw', { ...context, phase: 'predicate', reason: `${phase} predicate threw` });
      return null;
    }
  };

  const contracted = function (this: unknown, ...args: never[]): unknown {
    const preReason = evaluate('pre', () => spec.pre?.(...args));
    if (preReason) record('contract violated', { ...context, phase: 'pre', reason: preReason });
    const settle = (result: never): void => {
      const postReason = evaluate('post', () => spec.post?.(result, ...args));
      if (postReason) record('contract violated', { ...context, phase: 'post', reason: postReason });
      else if (!preReason) observed(spec, context);
    };
    const rejected = (error: unknown): void => {
      const throwReason = evaluate('postThrow', () => spec.postThrow?.(error, ...args));
      if (throwReason) record('contract violated', { ...context, phase: 'postThrow', reason: throwReason });
      else if (!preReason && spec.postThrow) observed(spec, context);
    };

    let result: unknown;
    try {
      result = fn.apply(this, args);
    } catch (error) {
      rejected(error);
      throw error;
    }
    if (!isThenable(result)) {
      settle(result as never);
      return result;
    }
    return Promise.resolve(result).then(
      (value) => { settle(value as never); return value; },
      (error: unknown) => { rejected(error); throw error; },
    );
  };
  return contracted as F;
}
