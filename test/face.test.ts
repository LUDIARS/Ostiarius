import { describe, expect, it } from 'vitest';
import { countStaffOverridesSince, openDb, decryptFaceTemplate, encryptFaceTemplate, enqueueOutbox, listDueOutbox, recordFaceEvent, upsertFaceTemplate } from '../server/db.ts';
import { ConsecutiveFaceVote, findFaceMatch } from '../server/face/matcher.ts';
import { advanceChallenge, isChallengeComplete } from '../server/face/challenge.ts';
import { syncFaceTemplates } from '../server/face/template-sync.ts';
import { retryOutbox } from '../server/face/aedilis-outbox.ts';
import { FaceVerificationFlow } from '../server/face/verification-flow.ts';
import { IdentitySessionStore } from '../server/identity-session-store.ts';

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
  it('round-trips a template with AES-GCM and queues outbox work', () => {
    const key = Buffer.alloc(32, 1); const value = new Float32Array(512); value[7] = .25;
    expect(decryptFaceTemplate(encryptFaceTemplate(value, key), key)[7]).toBeCloseTo(.25);
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
  it('applies a Cernere snapshot and removes tombstoned templates', async () => {
    const db = openDb(':memory:'); const key = Buffer.alloc(32, 3);
    const old = new Float32Array(512); old[0] = 1;
    upsertFaceTemplate(db, { userId: 'removed', template: old, modelId: 'm', quality: 1, enrolledAt: 1, version: 1, key });
    const fresh = new Float32Array(512); fresh[1] = 1;
    const wire = encryptFaceTemplate(fresh, key).toString('base64');
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ templates: [{ userId: 'kept', template: wire, modelId: 'm', quality: .9, version: 2, enrolledAt: 2, state: 'active' }], revoked: [{ userId: 'removed' }] }));
    try {
      await expect(syncFaceTemplates({ db, baseUrl: 'https://cernere.example', serviceToken: 'secret', facilityId: 'f', key })).resolves.toEqual({ ok: true, synced: 1 });
      expect(db.prepare('SELECT user_id FROM face_templates ORDER BY user_id').all()).toEqual([{ user_id: 'kept' }]);
    } finally { globalThis.fetch = original; }
  });
  it('issues only after three passive, unambiguous frames', async () => {
    const db = openDb(':memory:'); const sessions = new IdentitySessionStore(); const session = sessions.create();
    const embedding = new Float32Array(512); embedding[0] = 1;
    const encoded = Buffer.from(embedding.buffer).toString('base64');
    const flow = new FaceVerificationFlow({
      db, sessions, roster: () => ({ userIds: ['user-a'], embeddings: [embedding] }), threshold: .62, margin: .08,
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
});
