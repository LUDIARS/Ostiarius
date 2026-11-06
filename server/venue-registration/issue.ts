// 会場 LAN から届いた nonce に、会場登録の attestation を発行して Cernere へ送る
// (spec/feature/venue-registration.md §2)。
//
// 本人確認の段は無い (新規登録者は顔もパスキーもまだ持たない)。届いた時点で署名して送る。
// 同じ nonce は 1 回だけ (nonce_reused)。結果は Cernere が受理したかどうかだけを返し、
// 端末は Cernere の status (verified) を見て登録を続ける。

import type { KeyObject } from 'node:crypto';
import { signVenueRegistrationAttestation } from './attestation.ts';
import type { VenueRegistrationSubmitResult, VenueRegistrationSubmitter } from './cernere-submit.ts';
import type { VenueRegistrationNonceLedger } from './nonce-ledger.ts';
import { contract } from '../contract-runtime.ts'; /* augur-inject:import:bb4b103e */
import augurContract_7ea7acbe from '../../contracts/issue-venue-registration.contract.ts'; /* augur-inject:contract-predicate:b81a78aa */

export interface VenueRegistrationIssueDeps {
  nonces: VenueRegistrationNonceLedger;
  privateKey: KeyObject;
  lanId: string;
  /** OSTIARIUS_FACILITY_ID (= Cernere の組織 UUID)。 */
  facilityId: string;
  submit: VenueRegistrationSubmitter;
}

export type VenueRegistrationIssueResult =
  | { status: 'accepted' }
  | { status: 'rejected'; error: 'nonce_reused' | Extract<VenueRegistrationSubmitResult, { status: 'rejected' }>['error'] };

export async function issueVenueRegistration(deps: VenueRegistrationIssueDeps, nonce: string): Promise<VenueRegistrationIssueResult> {
  if (!deps.nonces.claim(nonce)) return { status: 'rejected', error: 'nonce_reused' };
  const attestation = signVenueRegistrationAttestation({
    placeId: deps.facilityId,
    lanId: deps.lanId,
    nonce,
    issuedAt: deps.nonces.now(),
  }, deps.privateKey);
  try {
    return await deps.submit(attestation);
  } catch {
    return { status: 'rejected', error: 'submit_failed' };
  }
}
// @ts-expect-error augur-inject
issueVenueRegistration = contract(issueVenueRegistration, { ...augurContract_7ea7acbe, contractId: 'C-26', mode: 'observe', sample: 1, where: 'server/venue-registration/issue.ts:26', rule: 'contract-wrap', id: '7ea7acbe' }); /* augur-inject:contract-wrap:7ea7acbe */
