// C-25 submitVenueRegistrationAttestation(options, attestation)
//
// Cernere の会場登録受け口へ送るのは purpose:"registration" の署名済み attestation だけ。
// 応答は accepted か、Cernere の固定語彙 / Ostiarius 側の送信失敗コードへ写す。

import { ATTESTATION_FIELD_ORDER, b64urlDecode } from '../server/attestation.ts';
import { CERNERE_LOCAL_SUBMIT_ERROR_CODES } from '../server/cernere-attestation-submit.ts';
import { VENUE_REGISTRATION_ERROR_CODES, type VenueRegistrationSubmitResult } from '../server/venue-registration/cernere-submit.ts';

// 対象モジュールと相互 import になるので、定数は述語の評価時に読む。

export default {
  pre: (_options: unknown, attestation: string) => {
    const [body, sig] = attestation.split('.');
    if (!body || !sig) return 'attestation must be payload.signature';
    const payload = JSON.parse(b64urlDecode(body).toString('utf8')) as Record<string, unknown>;
    if (!Object.keys(payload).every((key) => (ATTESTATION_FIELD_ORDER as readonly string[]).includes(key))) return 'payload must carry only the fixed attestation fields';
    return payload.purpose === 'registration' || 'only purpose:"registration" may be sent to the venue registration endpoint';
  },
  post: (result: VenueRegistrationSubmitResult) => {
    if (result.status === 'accepted') return true;
    return ([...VENUE_REGISTRATION_ERROR_CODES, ...CERNERE_LOCAL_SUBMIT_ERROR_CODES] as string[]).includes(result.error)
      || 'a rejection must use the fixed error vocabulary';
  },
};
