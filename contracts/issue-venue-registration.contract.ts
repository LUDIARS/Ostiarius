// C-26 issueVenueRegistration(deps, nonce)
//
// 同じ nonce は保持期間内に 1 回だけ署名・送信する。accepted は Cernere が受理したときだけ返す。
// 結果は固定語彙 (nonce_reused / Cernere の拒否コード / 送信失敗コード) に限る。

import { CERNERE_LOCAL_SUBMIT_ERROR_CODES } from '../server/cernere-attestation-submit.ts';
import { VENUE_REGISTRATION_ERROR_CODES } from '../server/venue-registration/cernere-submit.ts';
import type { VenueRegistrationIssueResult } from '../server/venue-registration/issue.ts';

export default {
  post: (result: VenueRegistrationIssueResult) => {
    if (result.status === 'accepted') return true;
    const allowed = ['nonce_reused', ...VENUE_REGISTRATION_ERROR_CODES, ...CERNERE_LOCAL_SUBMIT_ERROR_CODES] as string[];
    return allowed.includes(result.error) || 'a rejection must use the fixed error vocabulary';
  },
};
