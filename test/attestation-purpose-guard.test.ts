import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomBytes } from 'node:crypto';

import { attendanceSender } from '../server/attendance-delivery.ts';
import { b64urlEncode, signAttestation } from '../server/attestation.ts';
import { foreignAttestationPurpose } from '../server/attestation-purpose-guard.ts';
import { submitCernereAttestation } from '../server/cernere-attestation-submit.ts';
import { countOutbox, enqueueOutbox, openDb } from '../server/db.ts';
import { ATTESTATION_TARGET, deliverAttestation, retryOutbox } from '../server/face/aedilis-outbox.ts';
import { ONSITE_MFA_ENDPOINT } from '../server/onsite-mfa/cernere-submit.ts';
import { signVenueRegistrationAttestation } from '../server/venue-registration/attestation.ts';

const { privateKey } = generateKeyPairSync('ed25519');
const FACILITY_ID = '6f1c2b8e-4d3a-4f6b-9c2d-1a2b3c4d5e6f';

function registration(): string {
  return signVenueRegistrationAttestation({ placeId: FACILITY_ID, lanId: 'lan-1', nonce: randomBytes(32).toString('base64url'), issuedAt: Date.now() }, privateKey);
}

function subjectAttestation(purpose: 'attendance' | 'mfa'): string {
  return signAttestation({ sub: 'user-1', placeId: FACILITY_ID, lanId: 'lan-1', nonce: 'n', issuedAt: Date.now(), method: 'face', assurance: 'high', purpose }, privateKey);
}

describe('foreignAttestationPurpose (venue-registration §3)', () => {
  it('reports a purpose that differs from the route and ignores the matching one', () => {
    expect(foreignAttestationPurpose(registration(), 'attendance')).toBe('registration');
    expect(foreignAttestationPurpose(registration(), 'mfa')).toBe('registration');
    expect(foreignAttestationPurpose(subjectAttestation('mfa'), 'attendance')).toBe('mfa');
    expect(foreignAttestationPurpose(subjectAttestation('attendance'), 'attendance')).toBeNull();
    expect(foreignAttestationPurpose(registration(), 'registration')).toBeNull();
  });

  it('reads a legacy payload without purpose as attendance', () => {
    const legacy = `${b64urlEncode(Buffer.from(JSON.stringify({ sub: 'u', placeId: 'p', lanId: 'l', nonce: 'n', issuedAt: 1 })))}.sig`;
    expect(foreignAttestationPurpose(legacy, 'attendance')).toBeNull();
    expect(foreignAttestationPurpose(legacy, 'mfa')).toBe('attendance');
  });

  it('leaves unreadable tokens to the receiver signature check', () => {
    expect(foreignAttestationPurpose('opaque', 'attendance')).toBeNull();
    expect(foreignAttestationPurpose('not-json.sig', 'attendance')).toBeNull();
  });
});

describe('attendance (Aedilis) refuses registration attestations', () => {
  it('does not send a registration attestation to Aedilis', async () => {
    const send = vi.fn<typeof fetch>();
    expect(await attendanceSender('https://ae.example', 'token', send)(registration()))
      .toEqual({ status: 'failed', code: 'ATTESTATION_PURPOSE_NOT_ATTENDANCE' });
    expect(send).not.toHaveBeenCalled();
  });

  it('does not queue a registration attestation for retry and drops queued ones', async () => {
    const db = openDb(':memory:');
    expect(await deliverAttestation(db, 'https://ae.example', 'token', registration())).toBe(false);
    expect(countOutbox(db)).toBe(0);

    enqueueOutbox(db, ATTESTATION_TARGET, JSON.stringify({ attestation: registration() }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      await retryOutbox(db, 'https://ae.example', 'token');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(countOutbox(db)).toBe(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('onsite MFA refuses registration attestations', () => {
  it('does not send a registration attestation to the MFA endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await submitCernereAttestation(ONSITE_MFA_ENDPOINT, { cernereBaseUrl: 'https://cr.example', serviceToken: async () => 't', fetchImpl }, registration()))
      .toEqual({ status: 'rejected', error: 'purpose_not_allowed' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('still sends mfa attestations to the MFA endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ accepted: true }));
    expect(await submitCernereAttestation(ONSITE_MFA_ENDPOINT, { cernereBaseUrl: 'https://cr.example', serviceToken: async () => 't', fetchImpl }, subjectAttestation('mfa')))
      .toEqual({ status: 'accepted' });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('https://cr.example/api/mfa/onsite/attestations');
  });
});
