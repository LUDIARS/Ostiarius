// C-27 foreignAttestationPurpose(attestation, expected)
//
// 出席・MFA の送信経路は、expected 以外の purpose (registration を含む) を送らない。
// 返り値が null でなければ、それは expected と異なる purpose でなければならない。

import type { AttestationPurpose } from '../server/attestation.ts';

const PURPOSES = new Set(['attendance', 'mfa', 'location', 'registration']);

export default {
  post: (foreign: AttestationPurpose | null, _attestation: string, expected: AttestationPurpose) => {
    if (foreign === null) return true;
    if (!PURPOSES.has(foreign)) return 'a foreign purpose must be a known purpose';
    return foreign !== expected || 'the expected purpose must not be reported as foreign';
  },
};
