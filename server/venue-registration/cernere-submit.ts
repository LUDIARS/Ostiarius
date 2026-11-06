// 会場登録の attestation を Cernere へ直接送る (spec/feature/venue-registration.md §6)。
//
//   POST {CERNERE_BASE_URL}/api/auth/venue-registration/attestations
//   Authorization: Bearer <project token (service_scopes に venue-registration:submit)>
//   body { attestation }
//   200 { accepted: true } / 4xx { error: <固定語彙> }
//
// 送るのは purpose:"registration" の署名済み attestation だけ (それ以外は purpose_not_allowed)。
// 送信の共通部は ../cernere-attestation-submit.ts (現地確認 MFA と同じ)。

import {
  submitCernereAttestation,
  type CernereAttestationEndpoint,
  type CernereAttestationSubmitResult,
  type CernereSubmitOptions,
} from '../cernere-attestation-submit.ts';
import { contract } from '../contract-runtime.ts'; /* augur-inject:import:67f2e092 */
import augurContract_14b83f9b from '../../contracts/submit-venue-registration-attestation.contract.ts'; /* augur-inject:contract-predicate:b19458e7 */

/** Cernere が返す拒否コード (設計書 §3 の検証順の失敗コード + 形式不正)。 */
export const VENUE_REGISTRATION_ERROR_CODES = [
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
  'organization_unknown',
] as const;

export type VenueRegistrationErrorCode = (typeof VENUE_REGISTRATION_ERROR_CODES)[number];

export type VenueRegistrationSubmitResult = CernereAttestationSubmitResult<VenueRegistrationErrorCode>;

export type VenueRegistrationSubmitter = (attestation: string) => Promise<VenueRegistrationSubmitResult>;

export const VENUE_REGISTRATION_ENDPOINT: CernereAttestationEndpoint<VenueRegistrationErrorCode> = {
  path: '/api/auth/venue-registration/attestations',
  purpose: 'registration',
  errorCodes: VENUE_REGISTRATION_ERROR_CODES,
};

export async function submitVenueRegistrationAttestation(options: CernereSubmitOptions, attestation: string): Promise<VenueRegistrationSubmitResult> {
  return submitCernereAttestation(VENUE_REGISTRATION_ENDPOINT, options, attestation);
}
// @ts-expect-error augur-inject
submitVenueRegistrationAttestation = contract(submitVenueRegistrationAttestation, { ...augurContract_14b83f9b, contractId: 'C-25', mode: 'observe', sample: 1, where: 'server/venue-registration/cernere-submit.ts:46', rule: 'contract-wrap', id: '14b83f9b' }); /* augur-inject:contract-wrap:14b83f9b */

export function venueRegistrationSubmitter(options: CernereSubmitOptions): VenueRegistrationSubmitter {
  return (attestation) => submitVenueRegistrationAttestation(options, attestation);
}
