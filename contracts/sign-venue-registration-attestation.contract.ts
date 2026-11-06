// C-24 signVenueRegistrationAttestation(input, privateKey)
//
// 会場登録の attestation は本人確認をしない (spec/feature/venue-registration.md §3)。
// payload は既存の固定 8 フィールド順で、sub=null・method=lan・assurance=network・purpose=registration。
// payload の値 (nonce など) は理由文字列に載せない。

import { ATTESTATION_FIELD_ORDER, b64urlDecode } from '../server/attestation.ts';

export default {
  post: (token: string) => {
    const [body, sig] = token.split('.');
    if (!body || !sig) return 'attestation must be payload.signature';
    const payload = JSON.parse(b64urlDecode(body).toString('utf8')) as Record<string, unknown>;
    if (Object.keys(payload).join(',') !== ATTESTATION_FIELD_ORDER.join(',')) return 'payload keys must follow the fixed order';
    if (payload.sub !== null) return 'registration must not carry a subject';
    if (payload.method !== 'lan' || payload.assurance !== 'network') return 'registration must be method=lan, assurance=network';
    return payload.purpose === 'registration' || 'purpose must be registration';
  },
};
