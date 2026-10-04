import { contract } from '../contract-runtime.ts'; /* augur-inject:import:6168ceb2 */
import augurContract_93480796 from '../contracts/resolve-facility-location.contract.ts'; /* augur-inject:contract-predicate:b9a88207 */
// 会場位置の設定 (spec/feature/gps-location-statement.md §2)。
//
// OSTIARIUS_FACILITY_LAT / OSTIARIUS_FACILITY_LON (10 進度) / OSTIARIUS_FACILITY_RADIUS_M (整数 m)。
// 3 値が揃って範囲内のときだけ位置を返す。欠けるか不正なら null = 位置の宣言を出さない
// (GPS チェックイン不可)。GPS は任意機能なので、不正値でも起動は止めずに警告だけ出す。

export interface FacilityLocation {
  lat: number;
  lon: number;
  radiusM: number;
}

type Env = Record<string, string | undefined>;

const LAT_KEY = 'OSTIARIUS_FACILITY_LAT';
const LON_KEY = 'OSTIARIUS_FACILITY_LON';
const RADIUS_KEY = 'OSTIARIUS_FACILITY_RADIUS_M';

function parseDecimal(raw: string): number | null {
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseRadius(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function resolveFacilityLocation(env: Env): FacilityLocation | null {
  const latRaw = env[LAT_KEY]?.trim();
  const lonRaw = env[LON_KEY]?.trim();
  const radiusRaw = env[RADIUS_KEY]?.trim();
  if (!latRaw || !lonRaw || !radiusRaw) return null;

  const lat = parseDecimal(latRaw);
  const lon = parseDecimal(lonRaw);
  const radiusM = parseRadius(radiusRaw);
  if (lat === null || lat < -90 || lat > 90) return invalid(LAT_KEY);
  if (lon === null || lon < -180 || lon > 180) return invalid(LON_KEY);
  if (radiusM === null) return invalid(RADIUS_KEY);
  return { lat, lon, radiusM };
}
// @ts-expect-error augur-inject
resolveFacilityLocation = contract(resolveFacilityLocation, { ...augurContract_93480796, contractId: 'C-23', mode: 'observe', sample: 1, where: 'server/facility-location.ts:31', rule: 'contract-wrap', id: '93480796' }); /* augur-inject:contract-wrap:93480796 */

function invalid(key: string): null {
  // 値そのものは出さない (会場の座標をログへ残さない)。
  console.warn(`[ostiarius] ${key} が不正なため位置の宣言を出しません (GPS チェックイン不可)`);
  return null;
}
