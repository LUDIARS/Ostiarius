// 現地確認 MFA の attestation を Cernere へ直接送る (利用者端末を中継しない)。
//
// 契約 C: POST {CERNERE_BASE_URL}/api/mfa/onsite/attestations
//   Authorization: Bearer <project client credentials の service token (scope onsite-mfa:submit)>
//   body { attestation }
//   200 { accepted: true } / 4xx { error: <固定語彙> }
//
// 送るのは purpose:"mfa" の署名済み attestation だけ。registration などは送る前に
// purpose_not_allowed で断る (spec/feature/venue-registration.md §3)。顔画像・テンプレート・
// スコアは送らない (顔データの正本は Ostiarius ローカル、spec/plan/face-data-local-only.md)。
// 送信の共通部は ../cernere-attestation-submit.ts。

import {
  submitCernereAttestation,
  type CernereAttestationEndpoint,
  type CernereAttestationSubmitResult,
  type CernereSubmitOptions,
} from '../cernere-attestation-submit.ts';
import { contract } from '../contract-runtime.ts'; /* augur-inject:import:ed2ac2c0 */
import augurContract_aa981358 from '../../contracts/submit-onsite-mfa-attestation.contract.ts'; /* augur-inject:contract-predicate:a03279dd */

export type { LocalSubmitErrorCode } from '../cernere-attestation-submit.ts';

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

export type OnsiteMfaSubmitResult = CernereAttestationSubmitResult<CernereOnsiteErrorCode>;

export type OnsiteMfaSubmitter = (attestation: string) => Promise<OnsiteMfaSubmitResult>;

export type OnsiteMfaSubmitOptions = CernereSubmitOptions;

export const ONSITE_MFA_ENDPOINT: CernereAttestationEndpoint<CernereOnsiteErrorCode> = {
  path: '/api/mfa/onsite/attestations',
  purpose: 'mfa',
  errorCodes: CERNERE_ONSITE_ERROR_CODES,
};

export async function submitOnsiteMfaAttestation(options: OnsiteMfaSubmitOptions, attestation: string): Promise<OnsiteMfaSubmitResult> {
  return submitCernereAttestation(ONSITE_MFA_ENDPOINT, options, attestation);
}
// @ts-expect-error augur-inject
submitOnsiteMfaAttestation = contract(submitOnsiteMfaAttestation, { ...augurContract_aa981358, contractId: 'C-13', mode: 'observe', sample: 1, where: 'server/onsite-mfa/cernere-submit.ts:69', rule: 'contract-wrap', id: 'aa981358' }); /* augur-inject:contract-wrap:aa981358 */

export function onsiteMfaSubmitter(options: OnsiteMfaSubmitOptions): OnsiteMfaSubmitter {
  return (attestation) => submitOnsiteMfaAttestation(options, attestation);
}
