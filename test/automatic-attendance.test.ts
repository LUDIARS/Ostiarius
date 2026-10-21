import { describe, it, expect } from 'vitest';
import { createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import { automaticAttendanceConfig, verifyFacilityChallenge } from '../server/automatic-attendance.ts';
import { makeAutomaticCheckinRouter } from '../server/routes/automatic-checkin.ts';
import { verifyAttestation } from '../server/attestation.ts';

const secret = randomBytes(32).toString('base64url');
const now = 1_000_000;
function ticket(patch: Record<string, unknown> = {}): string {
  const payload = Buffer.from(JSON.stringify({ purpose: 'glab-facility-attendance', sub: 'user', facilityId: 'facility',
    lanId: 'lan', nonce: 'abcdefghijklmnop1234', issuedAt: now - 1, expiresAt: now + 1000, ...patch })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

describe('automatic facility proof', () => {
  it('accepts only an authentic, current, gateway-specific attendance challenge', () => {
    expect(verifyFacilityChallenge(ticket(), secret, 'facility', 'lan', now)?.sub).toBe('user');
    for (const patch of [{ purpose: 'mfa' }, { facilityId: 'other' }, { lanId: 'other' },
      { expiresAt: now }, { issuedAt: now + 1 }, { expiresAt: now + 100_000 }]) {
      expect(verifyFacilityChallenge(ticket(patch), secret, 'facility', 'lan', now)).toBeNull();
    }
    expect(verifyFacilityChallenge(ticket(), secret + 'wrong', 'facility', 'lan', now)).toBeNull();
  });
  it('requires TLS, a specific origin and the enrolled LAN interface', () => {
    expect(automaticAttendanceConfig({}, true)).toBeNull();
    expect(() => automaticAttendanceConfig({ OSTIARIUS_GLAB_ATTENDANCE_SECRET: secret }, true)).toThrow();
    const env = { OSTIARIUS_GLAB_ATTENDANCE_SECRET: secret, OSTIARIUS_GLAB_ORIGIN: 'https://glab.example', OSTIARIUS_COCOIRU_LAN_INTERFACE: 'Ethernet' };
    expect(() => automaticAttendanceConfig(env, false)).toThrow();
    expect(automaticAttendanceConfig(env, true)?.origin).toBe('https://glab.example');
  });
  it('issues a bound proof once and rejects requests outside the venue LAN', async () => {
    const keys = generateKeyPairSync('ed25519');
    let sameLan = false;
    const app = makeAutomaticCheckinRouter({ secret, facilityId: 'facility', lanId: 'lan', privateKey: keys.privateKey,
      isSameLan: () => sameLan, now: () => now });
    const request = () => app.request('/checkin/automatic', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challenge: ticket() }) });
    expect((await request()).status).toBe(403);
    sameLan = true;
    const response = await request();
    expect(response.status).toBe(200);
    const body = await response.json() as { attestation: string };
    const proof = verifyAttestation(body.attestation, keys.publicKey);
    expect(proof.payload).toMatchObject({ sub: 'user', placeId: 'facility', lanId: 'lan', purpose: 'attendance', method: 'session' });
    expect((await request()).status).toBe(409);
  });
});
