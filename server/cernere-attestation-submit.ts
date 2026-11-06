// 署名済み attestation を Cernere の受け口へ project token で送る共通部
// (現地確認 MFA: onsite-mfa/cernere-submit.ts、会場登録: venue-registration/cernere-submit.ts)。
//
//   POST {CERNERE_BASE_URL}{path}
//   Authorization: Bearer <project client credentials の service token>
//   body { attestation }
//   200 { accepted: true } / 4xx { error: <受け口ごとの固定語彙> }
//
// 受け口ごとに決まった purpose 以外の attestation は送る前に断る (purpose_not_allowed)。
// MFA の受け口へ registration を、会場登録の受け口へ mfa / attendance を流さないため
// (spec/feature/venue-registration.md §3)。送るのは署名済み attestation だけ。

import type { AttestationPurpose } from './attestation.ts';
import { foreignAttestationPurpose } from './attestation-purpose-guard.ts';
import type { ServiceTokenProvider } from './cernere-service-token.ts';

/**
 * Ostiarius 側で決まる送信失敗。Cernere の語彙と混ぜないよう別に持つ。
 * - purpose_not_allowed: 受け口の用途と違う attestation (送らない)
 * - service_token_unavailable: project client credentials で token を取れない
 * - cernere_unreachable: 通信失敗・タイムアウト
 * - submit_unauthorized: 401/403 (service_scopes の未宣言など)
 * - submit_failed: 上記以外の想定外の応答
 */
export const CERNERE_LOCAL_SUBMIT_ERROR_CODES = [
  'purpose_not_allowed',
  'service_token_unavailable',
  'cernere_unreachable',
  'submit_unauthorized',
  'submit_failed',
] as const;

export type LocalSubmitErrorCode = (typeof CERNERE_LOCAL_SUBMIT_ERROR_CODES)[number];

export type CernereAttestationSubmitResult<Code extends string> =
  | { status: 'accepted' }
  | { status: 'rejected'; error: Code | LocalSubmitErrorCode };

export interface CernereSubmitOptions {
  cernereBaseUrl: string;
  serviceToken: ServiceTokenProvider;
  /** テスト注入用。未指定ならグローバル fetch。 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** 受け口の定義。path・送ってよい purpose・Cernere の拒否コードの語彙。 */
export interface CernereAttestationEndpoint<Code extends string> {
  path: string;
  purpose: AttestationPurpose;
  errorCodes: readonly Code[];
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === 'object' ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function submitCernereAttestation<Code extends string>(
  endpoint: CernereAttestationEndpoint<Code>,
  options: CernereSubmitOptions,
  attestation: string,
): Promise<CernereAttestationSubmitResult<Code>> {
  if (foreignAttestationPurpose(attestation, endpoint.purpose) !== null) return { status: 'rejected', error: 'purpose_not_allowed' };

  let token: string;
  try {
    token = await options.serviceToken();
  } catch {
    return { status: 'rejected', error: 'service_token_unavailable' };
  }
  if (!token) return { status: 'rejected', error: 'service_token_unavailable' };

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${options.cernereBaseUrl.replace(/\/+$/, '')}${endpoint.path}`, {
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
  const code = body?.error;
  if (typeof code === 'string' && (endpoint.errorCodes as readonly string[]).includes(code)) return { status: 'rejected', error: code as Code };
  if (response.status === 401 || response.status === 403) return { status: 'rejected', error: 'submit_unauthorized' };
  return { status: 'rejected', error: 'submit_failed' };
}
