// 会場ネットワーク限定の新規登録の attestation (spec/feature/venue-registration.md §3)。
//
// Os は本人確認をしない。保証するのは「この nonce が会場 LAN 上の端末から Os へ届いた」ことだけ。
// payload は既存の固定順署名 (../attestation.ts) に載せ、値は次に固定する:
//   { sub: null, placeId, lanId, nonce, issuedAt, method: "lan", assurance: "network", purpose: "registration" }
// placeId は OSTIARIUS_FACILITY_ID (= Cernere の組織 UUID)。ただし Cernere は組織を kiosk 登録の
// placeId からだけ決めるので、ここで名乗る値は照合 (place_not_allowed) にしか使われない。

import type { KeyObject } from 'node:crypto';
import { signAttestation } from '../attestation.ts';
import { contract } from '../contract-runtime.ts'; /* augur-inject:import:7e1e0a25 */
import augurContract_37f8001b from '../../contracts/sign-venue-registration-attestation.contract.ts'; /* augur-inject:contract-predicate:cba3164c */

export interface VenueRegistrationAttestationInput {
  placeId: string;
  lanId: string;
  nonce: string;
  issuedAt: number;
}

export function signVenueRegistrationAttestation(input: VenueRegistrationAttestationInput, privateKey: KeyObject): string {
  return signAttestation({
    sub: null,
    placeId: input.placeId,
    lanId: input.lanId,
    nonce: input.nonce,
    issuedAt: input.issuedAt,
    method: 'lan',
    assurance: 'network',
    purpose: 'registration',
  }, privateKey);
}
// @ts-expect-error augur-inject
signVenueRegistrationAttestation = contract(signVenueRegistrationAttestation, { ...augurContract_37f8001b, contractId: 'C-24', mode: 'observe', sample: 1, where: 'server/venue-registration/attestation.ts:19', rule: 'contract-wrap', id: '37f8001b' }); /* augur-inject:contract-wrap:37f8001b */
