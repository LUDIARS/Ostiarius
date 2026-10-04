// 現地確認 MFA の attestation を Cernere へ直接送る (利用者端末を中継しない)。
//
// 契約 C: POST {CERNERE_BASE_URL}/api/mfa/onsite/attestations
//   Authorization: Bearer <project client credentials の service token (scope onsite-mfa:submit)>
//   body { attestation }
//   200 { accepted: true } / 4xx { error: <固定語彙> }
//
// 送るのは署名済み attestation だけ。顔画像・テンプレート・スコアは送らない
// (顔データの正本は Ostiarius ローカル、spec/plan/face-data-local-only.md)。

import type { ServiceTokenProvider } from '../cernere-service-token.ts';
import { contract } from '../contract-runtime.ts'; /* augur-inject:import:ed2ac2c0 */
import augurContract_aa981358 from '../../contracts/submit-onsite-mfa-attestation.contract.ts'; /* augur-inject:contract-predicate:a03279dd */

/** Cernere が返す拒否コード (契約 C の固定語彙)。 */
export const CERNERE_ONSITE_ERROR_CODES = [
  'invalid_format',
  'unknown_kiosk',
  'revoked_kiosk',
  'invalid_signature',
  'purpose_mismatch',
  'nonce_unknown',
  'nonce_used',
  'subject_mismatch',
  'stale',
  'assurance_insufficient',
  'place_not_allowed',
  'mfa_revision_changed',
] as const;

export type CernereOnsiteErrorCode = (typeof CERNERE_ONSITE_ERROR_CODES)[number];

/**
 * Ostiarius 側で決まる送信失敗。Cernere の語彙と混ぜないよう別に持つ。
 * - service_token_unavailable: project client credentials で token を取れない
 * - cernere_unreachable: 通信失敗・タイムアウト
 * - submit_unauthorized: 401/403 (scope onsite-mfa:submit の未宣言など)
 * - submit_failed: 上記以外の想定外の応答
 */
export type LocalSubmitErrorCode = 'service_token_unavailable' | 'cernere_unreachable' | 'submit_unauthorized' | 'submit_failed';

export type OnsiteMfaSubmitResult =
  | { status: 'accepted' }
  | { status: 'rejected'; error: CernereOnsiteErrorCode | LocalSubmitErrorCode };

export type OnsiteMfaSubmitter = (attestation: string) => Promise<OnsiteMfaSubmitResult>;

export interface OnsiteMfaSubmitOptions {
  cernereBaseUrl: string;
  serviceToken: ServiceTokenProvider;
  /** テスト注入用。未指定ならグローバル fetch。 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const KNOWN_CODES: ReadonlySet<string> = new Set(CERNERE_ONSITE_ERROR_CODES);

function isKnownCode(value: unknown): value is CernereOnsiteErrorCode {
  return typeof value === 'string' && KNOWN_CODES.has(value);
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === 'object' ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function submitOnsiteMfaAttestation(options: OnsiteMfaSubmitOptions, attestation: string): Promise<OnsiteMfaSubmitResult> {
  let token: string;
  try {
    token = await options.serviceToken();
  } catch {
    return { status: 'rejected', error: 'service_token_unavailable' };
  }
  if (!token) return { status: 'rejected', error: 'service_token_unavailable' };

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${options.cernereBaseUrl.replace(/\/+$/, '')}/api/mfa/onsite/attestations`, {
      method: 'POST',
      // The bearer token must never be forwarded to another origin.
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ attestation }),
    });
  } catch {
    return { status: 'rejected', error: 'cernere_unreachable' };
  }

  const body = await readJson(response);
  if (response.ok) return body?.accepted === true ? { status: 'accepted' } : { status: 'rejected', error: 'submit_failed' };
  if (isKnownCode(body?.error)) return { status: 'rejected', error: body.error };
  if (response.status === 401 || response.status === 403) return { status: 'rejected', error: 'submit_unauthorized' };
  return { status: 'rejected', error: 'submit_failed' };
}
// @ts-expect-error augur-inject
submitOnsiteMfaAttestation = contract(submitOnsiteMfaAttestation, { ...augurContract_aa981358, contractId: 'C-13', mode: 'observe', sample: 1, where: 'server/onsite-mfa/cernere-submit.ts:69', rule: 'contract-wrap', id: 'aa981358' }); /* augur-inject:contract-wrap:aa981358 */

export function onsiteMfaSubmitter(options: OnsiteMfaSubmitOptions): OnsiteMfaSubmitter {
  return (attestation) => submitOnsiteMfaAttestation(options, attestation);
}
