// C-28 resolveFacilityId(value)
//
// OSTIARIUS_FACILITY_ID は Cernere の組織 UUID (spec/feature/venue-registration.md §4)。
// 返すのは小文字の UUID だけで、UUID でない値は throw して起動を止める (post に届かない)。

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default {
  post: (facilityId: string) => UUID.test(facilityId) || 'facilityId must be a lowercase organization UUID',
};
