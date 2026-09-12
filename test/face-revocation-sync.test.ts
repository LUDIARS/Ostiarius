// Cernere からの失効指示・同意 pull の受け入れ条件。
//
// spec/plan/face-data-local-only.md §4 / spec/interface/cernere-face-template.md §A:
//   - 失効指示 1 件でテンプレート・写真・同意の写しが同時に物理削除される
//   - Cernere にまだ API が無い (404) 場合は warn に留め、ローカル正本を壊さない
//   - 撤回済みの同意を pull したらその場で登録ごと消す
//   - 初回 / 復元直後は 30 日前から全量を取り直す

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { countFaceSubjectRows, getFaceConsentCopy, listFaceTemplates, openDb, setSyncState } from '../server/db.ts';
import { loadLocalFaceKeys } from '../server/face/local-key.ts';
import { storeFaceConsentCopy, storeFacePhoto, storeFaceTemplate } from '../server/face/local-store.ts';
import { applyFaceRevocations, pullFaceConsents, pullFaceRevocations, revocationSince, syncFaceData } from '../server/face/revocation-sync.ts';

const MODEL_ID = 'insightface/glintr100@1';
const originalFetch = globalThis.fetch;

function keys() {
  return loadLocalFaceKeys(mkdtempSync(join(tmpdir(), 'ostiarius-revoke-')));
}

function enrolled(db: ReturnType<typeof openDb>, local: ReturnType<typeof keys>, userId: string): void {
  const template = new Float32Array(512);
  template[1] = 1;
  storeFaceTemplate(db, local, {
    userId, facilityId: 'facility-1', template, modelId: MODEL_ID, quality: 1,
    state: 'active', consentId: `consent-${userId}`, enrolledBy: 'staff-1',
  });
  storeFacePhoto(db, local, {
    userId, facilityId: 'facility-1', bytes: Buffer.from([1, 2, 3]), contentType: 'image/jpeg', consentId: `consent-${userId}`,
  });
  storeFaceConsentCopy(db, { userId, consentId: `consent-${userId}`, policyVersion: 'face-local-v2', at: Date.now() });
}

function options(db: ReturnType<typeof openDb>) {
  return { db, baseUrl: 'https://cernere.example', serviceToken: async () => 'service-token', facilityId: 'facility-1' };
}

describe('face revocation / consent pull', () => {
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it('physically deletes the template, photo and consent copy for a revoked user', async () => {
    const db = openDb(':memory:'); const local = keys();
    enrolled(db, local, 'student-1');
    enrolled(db, local, 'student-2');
    globalThis.fetch = (async () => new Response(JSON.stringify({
      revocations: [{ userId: 'student-1', facilityId: 'facility-1', reason: 'withdrawn', at: Date.now() }],
    }), { status: 200 })) as typeof fetch;

    await expect(pullFaceRevocations(options(db))).resolves.toMatchObject({ ok: true, applied: 1 });
    expect(countFaceSubjectRows(db, 'student-1')).toEqual({ templates: 0, photos: 0, consents: 0 });
    expect(countFaceSubjectRows(db, 'student-2')).toEqual({ templates: 1, photos: 1, consents: 1 });
  });

  it('applies a revocation list directly, leaving nothing behind', () => {
    const db = openDb(':memory:'); const local = keys();
    enrolled(db, local, 'student-1');
    expect(applyFaceRevocations(db, [{ userId: 'student-1', facilityId: 'facility-1', reason: 'graduated', at: 1 }])).toBe(1);
    expect(listFaceTemplates(db)).toHaveLength(0);
    // 同じ指示を 2 度受けても副作用は無い (もう何も残っていない)。
    expect(applyFaceRevocations(db, [{ userId: 'student-1', facilityId: 'facility-1', reason: 'graduated', at: 1 }])).toBe(0);
  });

  it('treats a missing Cernere endpoint as unsupported and keeps the local records', async () => {
    const db = openDb(':memory:'); const local = keys();
    enrolled(db, local, 'student-1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    globalThis.fetch = (async () => new Response('{}', { status: 404 })) as typeof fetch;

    const result = await syncFaceData(options(db));
    expect(result.revocations).toMatchObject({ ok: false, unsupported: true });
    expect(result.consents).toMatchObject({ ok: false, unsupported: true });
    expect(countFaceSubjectRows(db, 'student-1')).toEqual({ templates: 1, photos: 1, consents: 1 });
    expect(warn).toHaveBeenCalled();
  });

  it('keeps the local records when Cernere is unreachable', async () => {
    const db = openDb(':memory:'); const local = keys();
    enrolled(db, local, 'student-1');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    globalThis.fetch = (async () => { throw new Error('network down'); }) as typeof fetch;

    await expect(pullFaceRevocations(options(db))).resolves.toMatchObject({ ok: false, unsupported: false });
    expect(countFaceSubjectRows(db, 'student-1').templates).toBe(1);
  });

  it('stores consent copies and deletes registrations whose consent was revoked', async () => {
    const db = openDb(':memory:'); const local = keys();
    enrolled(db, local, 'student-1');
    enrolled(db, local, 'student-2');
    const at = Date.now();
    globalThis.fetch = (async () => new Response(JSON.stringify({
      consents: [
        { userId: 'student-1', consentId: 'consent-1', policyVersion: 'face-local-v2', at, revokedAt: at },
        { userId: 'student-2', consentId: 'consent-2', policyVersion: 'face-local-v2', at, revokedAt: null },
      ],
    }), { status: 200 })) as typeof fetch;

    await expect(pullFaceConsents(options(db))).resolves.toMatchObject({ ok: true, applied: 2 });
    expect(countFaceSubjectRows(db, 'student-1')).toEqual({ templates: 0, photos: 0, consents: 0 });
    expect(getFaceConsentCopy(db, 'student-2')?.consent_id).toBe('consent-2');
  });

  it('asks for the last 30 days when no sync position is stored (restored backup)', () => {
    const db = openDb(':memory:');
    const now = Date.UTC(2026, 8, 12);
    expect(revocationSince(db, undefined, now)).toBe(now - 30 * 24 * 60 * 60 * 1000);
    setSyncState(db, 'face_revocations_since', String(now - 1_000));
    expect(revocationSince(db, undefined, now)).toBe(now - 1_000);
  });

  it('sends facilityId and since on the revocation request', async () => {
    const db = openDb(':memory:');
    const requested: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      requested.push(String(input));
      return new Response(JSON.stringify({ revocations: [] }), { status: 200 });
    }) as typeof fetch;

    await pullFaceRevocations(options(db));
    const url = new URL(requested[0] ?? '');
    expect(url.pathname).toBe('/api/identity/face-revocations');
    expect(url.searchParams.get('facilityId')).toBe('facility-1');
    expect(Number(url.searchParams.get('since'))).toBeGreaterThan(0);
  });
});
