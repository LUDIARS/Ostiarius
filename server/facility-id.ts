import { contract } from '../contract-runtime.ts'; /* augur-inject:import:d63c8b75 */
import augurContract_2ece7b72 from '../contracts/resolve-facility-id.contract.ts'; /* augur-inject:contract-predicate:e4a8c0a8 */
// OSTIARIUS_FACILITY_ID の検証 (spec/feature/venue-registration.md §4)。
//
// 施設 ID は Cernere の組織 UUID (organizations.id) とする。会場登録の kiosk 登録 placeId、
// 顔の同意・失効の facilityId、attestation の placeId はすべてこの値で揃える。
// UUID でない施設 ID (例: glab-main) を送ると Cernere の face-consents が 400 を返し、
// 同意の記録・失効の同期が黙って止まる。警告で済ませず、起動時の設定エラーにする。

export class FacilityIdConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FacilityIdConfigError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 前後の空白を除いた UUID を小文字で返す。UUID でなければ FacilityIdConfigError。 */
export function resolveFacilityId(value: string): string {
  const trimmed = value.trim();
  if (!UUID_PATTERN.test(trimmed)) {
    throw new FacilityIdConfigError(
      'OSTIARIUS_FACILITY_ID は Cernere の組織 UUID (organizations.id) を指定してください。'
      + ' UUID でない施設 ID (例: glab-main) では顔の同意記録と会場登録が Cernere に拒否されます。',
    );
  }
  return trimmed.toLowerCase();
}
// @ts-expect-error augur-inject
resolveFacilityId = contract(resolveFacilityId, { ...augurContract_2ece7b72, contractId: 'C-28', mode: 'observe', sample: 1, where: 'server/facility-id.ts:18', rule: 'contract-wrap', id: '2ece7b72' }); /* augur-inject:contract-wrap:2ece7b72 */
