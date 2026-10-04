// C-23 resolveFacilityLocation(env)
//
// OSTIARIUS_FACILITY_LAT / _LON / _RADIUS_M の 3 値が揃って範囲内のときだけ位置を返し、
// 1 つでも欠けるか不正なら null (宣言を出さない = GPS チェックイン不可) にする。

import type { FacilityLocation } from '../server/facility-location.ts';

type Env = Record<string, string | undefined>;

function isBlank(v: string | undefined): boolean {
  return v === undefined || v.trim() === '';
}

export default {
  post: (location: FacilityLocation | null, env: Env) => {
    const keys = ['OSTIARIUS_FACILITY_LAT', 'OSTIARIUS_FACILITY_LON', 'OSTIARIUS_FACILITY_RADIUS_M'];
    if (keys.some((k) => isBlank(env[k]))) return location === null || 'a missing value must disable the statement';
    if (location === null) return true;
    if (!(location.lat >= -90 && location.lat <= 90)) return 'lat must be within -90..90';
    if (!(location.lon >= -180 && location.lon <= 180)) return 'lon must be within -180..180';
    return (Number.isInteger(location.radiusM) && location.radiusM > 0) || 'radiusM must be a positive integer';
  },
};
