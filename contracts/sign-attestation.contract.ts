// C-10 signAttestation(payload, privateKey)
//
// 受け手 (Aedilis / Cernere) は payload を固定キー順で読む (spec/feature/onsite-mfa-factor.md §3)。
// 署名した payload が {sub, placeId, lanId, nonce, issuedAt, method, assurance, purpose} の順で、
// purpose が attendance | mfa | registration のいずれかであることを観測する。registration は本人確認を
// しないので sub=null・method=lan・assurance=network に固定し、逆に出席・MFA は sub を必ず持つ
// (spec/feature/venue-registration.md §3)。payload の値は理由文字列に載せない。

import { ATTESTATION_FIELD_ORDER, b64urlDecode } from '../server/attestation.ts';

const PURPOSES = new Set(['attendance', 'mfa', 'registration']);

export default {
  post: (token: string) => {
    const [body, sig] = token.split('.');
    if (!body || !sig) return 'attestation must be payload.signature';
    const payload = JSON.parse(b64urlDecode(body).toString('utf8')) as Record<string, unknown>;
    if (Object.keys(payload).join(',') !== ATTESTATION_FIELD_ORDER.join(',')) return 'payload keys must follow the fixed order';
    if (!PURPOSES.has(String(payload.purpose))) return 'purpose must be attendance, mfa or registration';
    if (payload.purpose === 'registration') {
      return (payload.sub === null && payload.method === 'lan' && payload.assurance === 'network')
        || 'registration must carry sub=null, method=lan and assurance=network';
    }
    return (typeof payload.sub === 'string' && payload.sub !== '' && payload.method !== 'lan' && payload.assurance !== 'network')
      || 'attendance and mfa must carry a subject and a non-network assurance';
  },
};
