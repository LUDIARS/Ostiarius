// C-22 signLocationStatement(payload, privateKey)
//
// 受け手 (Aedilis の GPS チェックイン) は payload を固定キー順で読む (spec/feature/gps-location-statement.md §3)。
// 署名した payload が {lanId, facilityId, lat, lon, radiusM, issuedAt, purpose} の順で、
// purpose が location であることを観測する。座標の値は理由文字列に載せない。

import { b64urlDecode } from '../server/attestation.ts';
import { LOCATION_STATEMENT_FIELD_ORDER } from '../server/location-statement.ts';

export default {
  post: (token: string) => {
    const [body, sig] = token.split('.');
    if (!body || !sig) return 'statement must be payload.signature';
    const payload = JSON.parse(b64urlDecode(body).toString('utf8')) as Record<string, unknown>;
    if (Object.keys(payload).join(',') !== LOCATION_STATEMENT_FIELD_ORDER.join(',')) return 'payload keys must follow the fixed order';
    return payload.purpose === 'location' || 'purpose must be location';
  },
};
