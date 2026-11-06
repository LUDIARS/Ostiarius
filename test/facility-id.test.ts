import { describe, expect, it } from 'vitest';

import { FacilityIdConfigError, resolveFacilityId } from '../server/facility-id.ts';

describe('resolveFacilityId (venue-registration §4)', () => {
  it('accepts a Cernere organization UUID and normalizes it to lowercase', () => {
    expect(resolveFacilityId(' 6F1C2B8E-4D3A-4F6B-9C2D-1A2B3C4D5E6F ')).toBe('6f1c2b8e-4d3a-4f6b-9c2d-1a2b3c4d5e6f');
  });

  it('fails startup with a configuration error for a non-UUID facility id', () => {
    for (const value of ['glab-main', 'room-101', '', '6f1c2b8e4d3a4f6b9c2d1a2b3c4d5e6f']) {
      expect(() => resolveFacilityId(value)).toThrow(FacilityIdConfigError);
    }
    expect(() => resolveFacilityId('glab-main')).toThrow(/OSTIARIUS_FACILITY_ID/);
  });
});
