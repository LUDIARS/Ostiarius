// C-10 signAttestation(payload, privateKey)
//
// 受け手 (Aedilis / Cernere) は payload を固定キー順で読む (spec/feature/onsite-mfa-factor.md §3)。
// 署名した payload が {sub, placeId, lanId, nonce, issuedAt, method, assurance, purpose} の順で、
// purpose が attendance | mfa のどちらかであることを観測する。payload の値は理由文字列に載せない。

import { ATTESTATION_FIELD_ORDER, b64urlDecode } from '../server/attestation.ts';

const PURPOSES = new Set(['attendance', 'mfa']);

export default {
  post: (token: string) => {
    const [body, sig] = token.split('.');
    if (!body || !sig) return 'attestation must be payload.signature';
    const payload = JSON.parse(b64urlDecode(body).toString('utf8')) as Record<string, unknown>;
    if (Object.keys(payload).join(',') !== ATTESTATION_FIELD_ORDER.join(',')) return 'payload keys must follow the fixed order';
    return PURPOSES.has(String(payload.purpose)) || 'purpose must be attendance or mfa';
  },
};
