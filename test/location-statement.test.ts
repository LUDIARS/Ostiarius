import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

import { b64urlDecode, b64urlEncode, verifyAttestation } from '../server/attestation.ts';
import { resolveFacilityLocation } from '../server/facility-location.ts';
import {
  createLocationStatementIssuer,
  locationStatementField,
  signLocationStatement,
  type LocationStatementPayload,
} from '../server/location-statement.ts';
import { makeLocationRouter } from '../server/routes/location.ts';

const FULL_ENV = {
  OSTIARIUS_FACILITY_LAT: '35.681236',
  OSTIARIUS_FACILITY_LON: '139.767125',
  OSTIARIUS_FACILITY_RADIUS_M: '150',
};

const BASE: LocationStatementPayload = {
  lanId: 'lan-1',
  facilityId: 'room-1',
  lat: 35.681236,
  lon: 139.767125,
  radiusM: 150,
  issuedAt: 1_700_000_000_000,
  purpose: 'location',
};

function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(b64urlDecode(token.split('.')[0] ?? '').toString('utf8')) as Record<string, unknown>;
}

describe('resolveFacilityLocation (gps-location-statement §2)', () => {
  it('returns the location when all three values are present', () => {
    expect(resolveFacilityLocation(FULL_ENV)).toEqual({ lat: 35.681236, lon: 139.767125, radiusM: 150 });
  });

  it.each(Object.keys(FULL_ENV))('disables the statement when %s is missing', (key) => {
    expect(resolveFacilityLocation({ ...FULL_ENV, [key]: undefined })).toBeNull();
    expect(resolveFacilityLocation({ ...FULL_ENV, [key]: '  ' })).toBeNull();
  });

  it.each([
    ['OSTIARIUS_FACILITY_LAT', '91'],
    ['OSTIARIUS_FACILITY_LAT', 'north'],
    ['OSTIARIUS_FACILITY_LON', '-180.5'],
    ['OSTIARIUS_FACILITY_RADIUS_M', '0'],
    ['OSTIARIUS_FACILITY_RADIUS_M', '12.5'],
    ['OSTIARIUS_FACILITY_RADIUS_M', '-10'],
  ])('disables the statement when %s=%s is invalid', (key, value) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveFacilityLocation({ ...FULL_ENV, [key]: value })).toBeNull();
    // 座標をログに残さない。
    expect(warn.mock.calls.flat().join(' ')).not.toContain(value);
    warn.mockRestore();
  });
});

describe('signLocationStatement (gps-location-statement §3)', () => {
  it('signs with the gateway key so the attestation verifier accepts it', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const token = signLocationStatement(BASE, privateKey);
    const verified = verifyAttestation(token, publicKey);
    expect(verified.ok).toBe(true);
    expect(decodePayload(token)).toEqual(BASE);
  });

  it('always tags purpose as location', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const token = signLocationStatement({ ...BASE, purpose: 'attendance' } as unknown as LocationStatementPayload, privateKey);
    expect(decodePayload(token).purpose).toBe('location');
  });

  it('signs the payload in the fixed key order', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const shuffled = { purpose: 'location', issuedAt: BASE.issuedAt, radiusM: 150, lon: BASE.lon, lat: BASE.lat, facilityId: 'room-1', lanId: 'lan-1' } as LocationStatementPayload;
    const token = signLocationStatement(shuffled, privateKey);
    expect(Object.keys(decodePayload(token))).toEqual(['lanId', 'facilityId', 'lat', 'lon', 'radiusM', 'issuedAt', 'purpose']);
  });

  it.each([
    ['lat', 36],
    ['radiusM', 5000],
    ['purpose', 'attendance'],
    ['issuedAt', 1_800_000_000_000],
  ])('fails verification when %s is rewritten', (field, value) => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const token = signLocationStatement(BASE, privateKey);
    const [, signature] = token.split('.');
    const rewritten = b64urlEncode(Buffer.from(JSON.stringify({ ...decodePayload(token), [field]: value })));
    expect(verifyAttestation(`${rewritten}.${signature}`, publicKey).ok).toBe(false);
  });
});

describe('location statement issuer and GET /api/location (gps-location-statement §4)', () => {
  it('issues nothing when the location is not configured', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const issue = createLocationStatementIssuer({ lanId: 'lan-1', facilityId: 'room-1', location: resolveFacilityLocation({}), privateKey });
    expect(issue()).toBeNull();
    expect(locationStatementField(issue())).toEqual({});
    const res = await makeLocationRouter(issue).request('/api/location');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'location_not_configured' });
  });

  it('signs a fresh statement per request with the current time', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    let now = 1_000;
    const issue = createLocationStatementIssuer({
      lanId: 'lan-1',
      facilityId: 'room-1',
      location: resolveFacilityLocation(FULL_ENV),
      privateKey,
      now: () => now,
    });
    const first = await (await makeLocationRouter(issue).request('/api/location')).json() as { locationStatement: string };
    now = 2_000;
    const second = issue();
    expect(verifyAttestation(first.locationStatement, publicKey).ok).toBe(true);
    expect(decodePayload(first.locationStatement)).toEqual({ ...BASE, issuedAt: 1_000 });
    expect(decodePayload(second ?? '').issuedAt).toBe(2_000);
    expect(locationStatementField(second)).toEqual({ locationStatement: second });
  });
});
