// C-11 attestationPurpose(payload)
//
// purpose 導入前に署名された payload (purpose 欠落) は出席用として読む。

import type { AttestationPayload, AttestationPurpose } from '../server/attestation.ts';

export default {
  post: (purpose: AttestationPurpose, payload: Pick<AttestationPayload, 'purpose'>) => {
    if (payload.purpose === undefined) return purpose === 'attendance' || 'a payload without purpose must read as attendance';
    return purpose === payload.purpose || 'an explicit purpose must be returned verbatim';
  },
};
