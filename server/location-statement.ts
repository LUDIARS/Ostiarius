// 位置の宣言 (spec/feature/gps-location-statement.md §3)。
//
// 形式は attestation と同じ `base64url(JSON payload) + "." + base64url(Ed25519 署名)` で、
// gateway 鍵で署名する。Aedilis は gateway_registry の lanId の公開鍵で検証し、
// スマホの GPS がこの会場位置の radiusM 以内かを判定する。payload のキー順は固定:
//   { lanId, facilityId, lat, lon, radiusM, issuedAt, purpose: "location" }
// purpose "location" は出席・MFA の attestation として受理されない (受け手は purpose_mismatch)。

import type { KeyObject } from 'node:crypto';
import { signCompactPayload } from './attestation.ts';
import type { FacilityLocation } from './facility-location.ts';
import { contract } from '../contract-runtime.ts'; /* augur-inject:import:89bdc487 */
import augurContract_88e74b29 from '../contracts/sign-location-statement.contract.ts'; /* augur-inject:contract-predicate:0ec4dac1 */

export interface LocationStatementPayload {
  lanId: string;
  facilityId: string;
  lat: number;
  lon: number;
  radiusM: number;
  issuedAt: number; // epoch ms (ゲートウェイ時計)。Aedilis は 15 分以内だけ受理する
  purpose: 'location';
}

/** payload のキー順。JSON.stringify は挿入順なので、この順で組み直してから署名する。 */
export const LOCATION_STATEMENT_FIELD_ORDER = ['lanId', 'facilityId', 'lat', 'lon', 'radiusM', 'issuedAt', 'purpose'] as const;

export function signLocationStatement(payload: LocationStatementPayload, privateKey: KeyObject): string {
  const canonical: LocationStatementPayload = {
    lanId: payload.lanId,
    facilityId: payload.facilityId,
    lat: payload.lat,
    lon: payload.lon,
    radiusM: payload.radiusM,
    issuedAt: payload.issuedAt,
    purpose: 'location',
  };
  return signCompactPayload(canonical, privateKey);
}
// @ts-expect-error augur-inject
signLocationStatement = contract(signLocationStatement, { ...augurContract_88e74b29, contractId: 'C-22', mode: 'observe', sample: 1, where: 'server/location-statement.ts:26', rule: 'contract-wrap', id: '88e74b29' }); /* augur-inject:contract-wrap:88e74b29 */

export interface LocationStatementIssuerDeps {
  lanId: string;
  facilityId: string;
  location: FacilityLocation | null;
  privateKey: KeyObject;
  now?: () => number;
}

/** 要求ごとに新しく署名する発行関数。位置が未設定なら常に null (宣言を出さない)。 */
export function createLocationStatementIssuer(deps: LocationStatementIssuerDeps): () => string | null {
  const { location } = deps;
  if (!location) return () => null;
  const now = deps.now ?? Date.now;
  return () => signLocationStatement({
    lanId: deps.lanId,
    facilityId: deps.facilityId,
    lat: location.lat,
    lon: location.lon,
    radiusM: location.radiusM,
    issuedAt: now(),
    purpose: 'location',
  }, deps.privateKey);
}

/** /api/health に足すフィールド。宣言が無ければキーごと省略する。 */
export function locationStatementField(locationStatement: string | null): { locationStatement?: string } {
  return locationStatement ? { locationStatement } : {};
}
