import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { countStaffOverridesSince, listFaceTemplates, openDb, enqueueOutbox, listDueOutbox, recordFaceEvent } from '../server/db.ts';
import { ConsecutiveFaceVote, findFaceMatch } from '../server/face/matcher.ts';
import { advanceChallenge, isChallengeComplete } from '../server/face/challenge.ts';
import { loadLocalFaceKeys, openFaceTemplate, sealFaceTemplate } from '../server/face/local-key.ts';
import { storeFaceConsentCopy, storeFaceTemplate } from '../server/face/local-store.ts';
import { buildFaceRoster } from '../server/face/template-roster.ts';
import { FACE_CONSENT_MAX_AGE_MS } from '../server/face/consent-policy.ts';
import { retryOutbox } from '../server/face/aedilis-outbox.ts';
import { FaceVerificationFlow } from '../server/face/verification-flow.ts';
import { IdentitySessionStore } from '../server/identity-session-store.ts';

const MODEL_ID = 'insightface/glintr100@1';

function keys() {
  return loadLocalFaceKeys(mkdtempSync(join(tmpdir(), 'ostiarius-face-')));
}

function embedding(index: number): Float32Array {
  const value = new Float32Array(512);
  value[index] = 1;
  return value;
}

describe('face domain', () => {
  it('requires an unambiguous three-frame match', () => {
    const first = new Float32Array(512); first[0] = 1; const second = new Float32Array(512); second[1] = 1;
    const match = findFaceMatch(first, { userIds: ['a', 'b'], embeddings: [first, second] });
    const votes = new ConsecutiveFaceVote();
    expect(votes.add(match, .62, .08)).toBeNull(); expect(votes.add(match, .62, .08)).toBeNull(); expect(votes.add(match, .62, .08)).toBe('a');
  });
  it('does not complete a blink until it closes and reopens', () => {
    const moved = advanceChallenge({ kind: 'blink', moved: false }, { blendshapes: { eyeBlinkLeft: .7, eyeBlinkRight: .7 } });
    expect(isChallengeComplete(moved, { blendshapes: { eyeBlinkLeft: .1, eyeBlinkRight: .1 } })).toBe(true);
  });
  it('round-trips a template with the host-local key and queues outbox work', () => {
    const local = keys();
    const value = new Float32Array(512); value[7] = .25;
    const sealed = sealFaceTemplate(local, value);
    expect(openFaceTemplate(local, sealed.keyId, sealed.sealed)[7]).toBeCloseTo(.25);
    const db = openDb(':memory:'); enqueueOutbox(db, 'aedilis:attest', '{}'); expect(listDueOutbox(db)).toHaveLength(1);
  });
  it('counts staff overrides separately for each staff member', () => {
    const db = openDb(':memory:');
    recordFaceEvent(db, { kind: 'staff_override', outcome: 'issued', actorUser: 'staff-a' });
    recordFaceEvent(db, { kind: 'staff_override', outcome: 'issued', actorUser: 'staff-b' });
    const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0);
    expect(countStaffOverridesSince(db, 'staff-a', startOfDay.getTime())).toBe(1);
    expect(countStaffOverridesSince(db, 'staff-b', startOfDay.getTime())).toBe(1);
  });

  it('stores templates sealed, never as raw embeddings', () => {
    const db = openDb(':memory:'); const local = keys();
    storeFaceTemplate(db, local, {
      userId: 'student-1', facilityId: 'facility-1', template: embedding(3), modelId: MODEL_ID,
      quality: 1, state: 'active', consentId: 'consent-1', enrolledBy: 'staff-1',
    });
    const row = listFaceTemplates(db)[0];
    expect(row?.key_id).toBe(local.template.keyId);
    // 平文 Float32 (2048 byte) がそのまま入っていない。
    expect(row?.template_enc.length).toBeGreaterThan(512 * 4);
    expect(row?.template_enc.includes(Buffer.from(embedding(3).buffer))).toBe(false);
  });

  it('keeps pending templates out of the matcher until they are active', () => {
    const db = openDb(':memory:'); const local = keys();
    storeFaceTemplate(db, local, {
      userId: 'photo-user', facilityId: 'facility-1', template: embedding(1), modelId: MODEL_ID,
      quality: .5, state: 'pending', consentId: 'consent-1', enrolledBy: 'staff-1',
    });
    storeFaceTemplate(db, local, {
      userId: 'active-user', facilityId: 'facility-1', template: embedding(2), modelId: MODEL_ID,
      quality: .9, state: 'active', consentId: 'consent-2', enrolledBy: 'staff-1',
    });
    expect(buildFaceRoster(db, local, MODEL_ID).userIds).toEqual(['active-user']);
  });

  it('drops a template from the matcher once its consent is older than 365 days', () => {
    const db = openDb(':memory:'); const local = keys();
    const now = Date.now();
    storeFaceTemplate(db, local, {
      userId: 'expired-user', facilityId: 'facility-1', template: embedding(4), modelId: MODEL_ID,
      quality: 1, state: 'active', consentId: 'consent-old', enrolledBy: 'staff-1', enrolledAt: now,
    });
    storeFaceConsentCopy(db, {
      userId: 'expired-user', consentId: 'consent-old', policyVersion: 'face-local-v2',
      at: now - FACE_CONSENT_MAX_AGE_MS - 1,
    });
    expect(buildFaceRoster(db, local, MODEL_ID, now).userIds).toEqual([]);
    // 再同意すれば戻る (登録そのものは消していない)。
    storeFaceConsentCopy(db, {
      userId: 'expired-user', consentId: 'consent-new', policyVersion: 'face-local-v2', at: now,
    });
    expect(buildFaceRoster(db, local, MODEL_ID, now).userIds).toEqual(['expired-user']);
  });

  it('drops a template from the matcher once its consent copy is revoked', () => {
    const db = openDb(':memory:'); const local = keys();
    const now = Date.now();
    storeFaceTemplate(db, local, {
      userId: 'revoked-user', facilityId: 'facility-1', template: embedding(5), modelId: MODEL_ID,
      quality: 1, state: 'active', consentId: 'consent-1', enrolledBy: 'staff-1',
    });
    storeFaceConsentCopy(db, {
      userId: 'revoked-user', consentId: 'consent-1', policyVersion: 'face-local-v2', at: now, revokedAt: now,
    });
    expect(buildFaceRoster(db, local, MODEL_ID, now).userIds).toEqual([]);
  });

  it('ignores templates built for another sidecar model', () => {
    const db = openDb(':memory:'); const local = keys();
    storeFaceTemplate(db, local, {
      userId: 'other-model', facilityId: 'facility-1', template: embedding(6), modelId: 'other/model@1',
      quality: 1, state: 'active', consentId: 'consent-1', enrolledBy: 'staff-1',
    });
    expect(buildFaceRoster(db, local, MODEL_ID).userIds).toEqual([]);
  });

  it('issues only after three passive, unambiguous frames', async () => {
    const db = openDb(':memory:'); const sessions = new IdentitySessionStore(); const session = sessions.create();
    const value = embedding(0);
    const encoded = Buffer.from(value.buffer).toString('base64');
    const flow = new FaceVerificationFlow({
      db, sessions, roster: () => ({ userIds: ['user-a'], embeddings: [value] }), threshold: .62, margin: .08,
      livenessThreshold: .9, challengeRequired: false, subjectHint: () => 'ID / 42',
      sidecar: { health: async () => ({ ok: true, modelId: 'm' }), analyze: async () => [{ quality: { pass: true, fail: [] }, liveness: .99, embedding: encoded }], embedBatch: async () => ({ embeddings: [], qualities: [] }) },
    });
    await expect(flow.process(session.sessionId, new Uint8Array())).resolves.toMatchObject({ state: 'scanning' });
    await expect(flow.process(session.sessionId, new Uint8Array())).resolves.toMatchObject({ state: 'scanning' });
    await expect(flow.process(session.sessionId, new Uint8Array())).resolves.toMatchObject({ state: 'issued', subjectUserId: 'user-a' });
    await expect(flow.process(session.sessionId, new Uint8Array())).resolves.toBeNull();
  });
  it('keeps failed Aedilis deliveries and retries due outbox entries', async () => {
    const db = openDb(':memory:'); enqueueOutbox(db, 'aedilis:attest', '{"attestation":"signed"}');
    const original = globalThis.fetch; globalThis.fetch = async () => new Response('', { status: 204 });
    try {
      await retryOutbox(db, 'https://aedilis.example', 'token');
      expect(listDueOutbox(db)).toHaveLength(0);
    } finally { globalThis.fetch = original; }
  });
  it('leaves consent revocations in the outbox for their own sender', async () => {
    const db = openDb(':memory:');
    enqueueOutbox(db, 'cernere:face-consent-revoke', '{"userId":"student-1"}');
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response('', { status: 204 });
    try {
      await retryOutbox(db, 'https://aedilis.example', 'token');
      // Aedilis の再送は attestation だけを拾う (同意撤回を Aedilis へ送らない)。
      expect(listDueOutbox(db).map((row) => row.target)).toEqual(['cernere:face-consent-revoke']);
    } finally { globalThis.fetch = original; }
  });
});
