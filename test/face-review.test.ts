// 写真由来 pending テンプレートの職員承認 (kiosk /enroll) の受け入れ条件。
//
// spec/feature/face-photo-seeded-enrollment.md §6:
//   - pending は職員が昇格するまで出席照合に一切載らない
//   - 却下は理由必須
//   - 承認 (撮り直し) 後に active が施設キャッシュへ入る
//   - 写真が Ostiarius のディスクに残らない

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { encryptFaceTemplate, listFaceTemplates, openDb } from '../server/db.ts';
import { syncFaceTemplates } from '../server/face/template-sync.ts';
import { buildFaceRoster } from '../server/face/template-roster.ts';
import { EnrollmentSessionStore } from '../server/face/enrollment-session.ts';
import { FaceReviewService } from '../server/face/review-service.ts';
import { StaffSessionStore } from '../server/face/staff-session.ts';
import { makeIdentityReviewRouter } from '../server/routes/identity-review.ts';
import type { CernerePhotoClient, PhotoResult } from '../server/face/cernere-photo-client.ts';
import type { CernereTemplateClient, PutTemplateInput } from '../server/face/cernere-template-client.ts';

const MODEL_ID = 'insightface/glintr100@1';
const KEY = Buffer.alloc(32, 5);

function embedding(index: number): Float32Array {
  const value = new Float32Array(512);
  value[index] = 1;
  return value;
}

function photoClientStub(overrides: Partial<CernerePhotoClient> = {}): CernerePhotoClient & {
  promoted: Array<{ userId: string; mode: string }>;
  rejected: Array<{ userId: string; reason: string }>;
} {
  const promoted: Array<{ userId: string; mode: string }> = [];
  const rejected: Array<{ userId: string; reason: string }> = [];
  return {
    promoted,
    rejected,
    fetchPhoto: async (): Promise<PhotoResult> => ({ kind: 'photo', photo: { bytes: Buffer.from([1, 2, 3]), contentType: 'image/jpeg' } }),
    promote: async (userId, mode) => { promoted.push({ userId, mode }); return true; },
    reject: async (userId, reason) => { rejected.push({ userId, reason }); return true; },
    ...overrides,
  };
}

function templateClientStub(): CernereTemplateClient & { stored: string[] } {
  const stored: string[] = [];
  return {
    stored,
    recordConsent: async () => 'consent-1',
    putTemplate: async (input: PutTemplateInput) => { stored.push(input.userId); return true; },
  } as unknown as CernereTemplateClient & { stored: string[] };
}

function reviewRouter(deps: {
  photos: CernerePhotoClient;
  review: FaceReviewService;
  db: ReturnType<typeof openDb>;
  enrollment: EnrollmentSessionStore;
  staff: StaffSessionStore;
  isCandidate?: (userId: string) => Promise<boolean>;
}): Hono {
  const router = new Hono();
  router.route('/', makeIdentityReviewRouter({
    db: deps.db,
    staff: deps.staff,
    photos: deps.photos,
    review: deps.review,
    enrollment: deps.enrollment,
    cernereBaseUrl: 'https://cernere.example',
    serviceToken: 'service-token',
    facilityId: 'facility-1',
    staffRoles: ['staff', 'admin'],
    shotsRequired: 6,
    isCandidate: deps.isCandidate ?? (async () => true),
  }));
  return router;
}

describe('photo-seeded enrollment review', () => {
  it('keeps pending templates out of the facility cache and the matcher', async () => {
    const db = openDb(':memory:');
    const wire = encryptFaceTemplate(embedding(1), KEY).toString('base64');
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      templates: [
        { userId: 'pending-user', template: wire, modelId: MODEL_ID, quality: 0.5, version: 1, state: 'pending' },
        { userId: 'active-user', template: wire, modelId: MODEL_ID, quality: 0.9, version: 1, state: 'active' },
        { userId: 'missing-state-user', template: wire, modelId: MODEL_ID, quality: 0.9, version: 1 },
      ],
      revoked: [],
    }));
    try {
      await syncFaceTemplates({ db, baseUrl: 'https://cernere.example', serviceToken: 'service-token', facilityId: 'facility-1', key: KEY });
    } finally {
      globalThis.fetch = original;
    }
    expect(listFaceTemplates(db).map((row) => row.user_id)).toEqual(['active-user']);
    expect(buildFaceRoster(db, KEY, MODEL_ID).userIds).toEqual(['active-user']);
  });

  it('refuses a rejection without a reason and never calls Cernere', async () => {
    const db = openDb(':memory:');
    const photos = photoClientStub();
    const staff = new StaffSessionStore();
    const enrollment = new EnrollmentSessionStore();
    const review = new FaceReviewService({
      db, photos, templates: templateClientStub(), enrollment, key: KEY, modelId: MODEL_ID,
      reviewerUserId: 'reviewer-1', syncNow: async () => ({ ok: true, synced: 0 }),
    });
    const router = reviewRouter({ photos, review, db, enrollment, staff });
    const staffSession = staff.create('staff-1');
    const response = await router.request('/identity/review/reject', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ostiarius-staff': staffSession },
      body: JSON.stringify({ userId: 'student-1', reason: '   ' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'reason_required' });
    expect(photos.rejected).toHaveLength(0);

    const accepted = await router.request('/identity/review/reject', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ostiarius-staff': staffSession },
      body: JSON.stringify({ userId: 'student-1', reason: '他人の写真だった' }),
    });
    expect(accepted.status).toBe(200);
    expect(photos.rejected).toEqual([{ userId: 'student-1', reason: '他人の写真だった' }]);

    const overlong = await router.request('/identity/review/reject', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ostiarius-staff': staffSession },
      body: JSON.stringify({ userId: 'student-1', reason: 'a'.repeat(257) }),
    });
    expect(overlong.status).toBe(400);
    expect(await overlong.json()).toEqual({ error: 'reason_too_long' });
    expect(photos.rejected).toHaveLength(1);
  });

  it('stores the re-enrolled template in the facility cache and promotes with mode=reenroll', async () => {
    const db = openDb(':memory:');
    const photos = photoClientStub();
    const templates = templateClientStub();
    const enrollment = new EnrollmentSessionStore();
    let synced = 0;
    const review = new FaceReviewService({
      db, photos, templates, enrollment, key: KEY, modelId: MODEL_ID,
      reviewerUserId: 'reviewer-1', syncNow: async () => { synced += 1; return { ok: true, synced }; },
    });
    const enrollId = enrollment.start('student-1', 'staff-1');
    enrollment.consent(enrollId, 'consent-1');
    for (let index = 0; index < 6; index += 1) {
      enrollment.add(enrollId, Buffer.from(embedding(index).buffer).toString('base64'), 1);
    }
    await expect(review.approve({ userId: 'student-1', mode: 'reenroll', staffUserId: 'staff-1', enrollId }))
      .resolves.toEqual({ ok: true, mode: 'reenroll' });
    expect(templates.stored).toEqual(['student-1']);
    expect(photos.promoted).toEqual([{ userId: 'student-1', mode: 'reenroll' }]);
    expect(listFaceTemplates(db).map((row) => row.user_id)).toEqual(['student-1']);
    expect(buildFaceRoster(db, KEY, MODEL_ID).userIds).toEqual(['student-1']);
    expect(synced).toBe(1);
  });

  it('rejects a re-enrollment approval that has too few shots', async () => {
    const db = openDb(':memory:');
    const photos = photoClientStub();
    const enrollment = new EnrollmentSessionStore();
    const review = new FaceReviewService({
      db, photos, templates: templateClientStub(), enrollment, key: KEY, modelId: MODEL_ID,
      reviewerUserId: 'reviewer-1', syncNow: async () => ({ ok: true, synced: 0 }),
    });
    const enrollId = enrollment.start('student-1', 'staff-1');
    enrollment.consent(enrollId, 'consent-1');
    enrollment.add(enrollId, Buffer.from(embedding(0).buffer).toString('base64'), 1);
    await expect(review.approve({ userId: 'student-1', mode: 'reenroll', staffUserId: 'staff-1', enrollId }))
      .resolves.toEqual({ ok: false, error: 'insufficient_shots' });
    expect(photos.promoted).toHaveLength(0);
    expect(listFaceTemplates(db)).toHaveLength(0);
  });

  it('serves the photo with private, no-store and never writes it to disk', async () => {
    const db = openDb(':memory:');
    const photos = photoClientStub();
    const staff = new StaffSessionStore();
    const enrollment = new EnrollmentSessionStore();
    const review = new FaceReviewService({
      db, photos, templates: templateClientStub(), enrollment, key: KEY, modelId: MODEL_ID,
      reviewerUserId: 'reviewer-1', syncNow: async () => ({ ok: true, synced: 0 }),
    });
    const router = reviewRouter({ photos, review, db, enrollment, staff });
    const writers = [
      vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined),
      vi.spyOn(fs, 'appendFileSync').mockImplementation(() => undefined),
      vi.spyOn(fs, 'createWriteStream'),
      vi.spyOn(fsPromises, 'writeFile'),
      vi.spyOn(fsPromises, 'appendFile'),
    ];
    try {
      const response = await router.request('/identity/review/photo/student-1', {
        headers: { 'x-ostiarius-staff': staff.create('staff-1') },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
      for (const writer of writers) expect(writer).not.toHaveBeenCalled();
    } finally {
      for (const writer of writers) writer.mockRestore();
    }
  });

  it('does not pass a non-candidate userId to the photo client', async () => {
    const db = openDb(':memory:');
    const photos = photoClientStub();
    const staff = new StaffSessionStore();
    const enrollment = new EnrollmentSessionStore();
    const review = new FaceReviewService({
      db, photos, templates: templateClientStub(), enrollment, key: KEY, modelId: MODEL_ID,
      reviewerUserId: 'reviewer-1', syncNow: async () => ({ ok: true, synced: 0 }),
    });
    const router = reviewRouter({ photos, review, db, enrollment, staff, isCandidate: async () => false });
    const response = await router.request('/identity/review/photo/other-facility-user', {
      headers: { 'x-ostiarius-staff': staff.create('staff-1') },
    });
    expect(response.status).toBe(404);
  });

  it('requires the student authCode for a re-enrollment session (consent needs the student token)', async () => {
    const db = openDb(':memory:');
    const photos = photoClientStub();
    const staff = new StaffSessionStore();
    const enrollment = new EnrollmentSessionStore();
    const review = new FaceReviewService({
      db, photos, templates: templateClientStub(), enrollment, key: KEY, modelId: MODEL_ID,
      reviewerUserId: 'reviewer-1', syncNow: async () => ({ ok: true, synced: 0 }),
    });
    const router = reviewRouter({ photos, review, db, enrollment, staff });
    const token = staff.create('staff-1');
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ userId: 'other-student', accessToken: 'student-access', expiresIn: 900 }),
      { status: 200 },
    )) as typeof fetch;
    const start = async (body: unknown): Promise<Response> => router.request('/identity/review/reenroll/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ostiarius-staff': token },
      body: JSON.stringify(body),
    });
    try {
      // コード無しでは開始できない (service token で同意を代筆させないため)。
      expect((await start({ userId: 'student-1' })).status).toBe(401);
      // 交換結果が審査対象と別人なら 409。
      expect((await start({ userId: 'student-1', studentAuthCode: 'code-1' })).status).toBe(409);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('requires a staff session for every review route', async () => {
    const db = openDb(':memory:');
    const photos = photoClientStub();
    const enrollment = new EnrollmentSessionStore();
    const review = new FaceReviewService({
      db, photos, templates: templateClientStub(), enrollment, key: KEY, modelId: MODEL_ID,
      reviewerUserId: 'reviewer-1', syncNow: async () => ({ ok: true, synced: 0 }),
    });
    const router = reviewRouter({ photos, review, db, enrollment, staff: new StaffSessionStore() });
    for (const path of ['/identity/review/candidates', '/identity/review/photo/student-1']) {
      expect((await router.request(path)).status).toBe(401);
    }
    for (const path of ['/identity/review/approve', '/identity/review/reject', '/identity/review/reenroll/start']) {
      const response = await router.request(path, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: 'student-1' }),
      });
      expect(response.status).toBe(401);
    }
  });
});
