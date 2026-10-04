// C-13 submitOnsiteMfaAttestation(options, attestation)
//
// Cernere へ送るのは purpose:"mfa" の署名済み attestation だけで、payload は固定 8 フィールドに限る
// (顔画像・テンプレート・スコアを載せない)。応答は accepted か、契約 C の固定語彙 /
// Ostiarius 側の送信失敗コードへ写す。

import { ATTESTATION_FIELD_ORDER, b64urlDecode } from '../server/attestation.ts';
import { CERNERE_ONSITE_ERROR_CODES, type OnsiteMfaSubmitResult } from '../server/onsite-mfa/cernere-submit.ts';

const LOCAL_ERROR_CODES = ['service_token_unavailable', 'cernere_unreachable', 'submit_unauthorized', 'submit_failed'];

// 対象モジュールと相互 import になるので、定数は述語の評価時に読む。

export default {
  pre: (_options: unknown, attestation: string) => {
    const [body, sig] = attestation.split('.');
    if (!body || !sig) return 'attestation must be payload.signature';
    const payload = JSON.parse(b64urlDecode(body).toString('utf8')) as Record<string, unknown>;
    if (!Object.keys(payload).every((key) => (ATTESTATION_FIELD_ORDER as readonly string[]).includes(key))) return 'payload must carry only the fixed attestation fields';
    return payload.purpose === 'mfa' || 'only purpose:"mfa" may be sent to Cernere';
  },
  post: (result: OnsiteMfaSubmitResult) => {
    if (result.status === 'accepted') return true;
    return [...CERNERE_ONSITE_ERROR_CODES, ...LOCAL_ERROR_CODES].includes(result.error) || 'a rejection must use the fixed error vocabulary';
  },
};
