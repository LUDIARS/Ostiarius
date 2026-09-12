// 写真由来 pending テンプレートの職員承認 (kiosk /enroll) の受け入れ条件。
//
// spec/feature/face-photo-seeded-enrollment.md §6:
//   - pending は職員が昇格するまで出席照合に一切載らない
//   - 却下は理由必須で、写真と pending が同時に消える
//   - 承認 (撮り直し) 後に active が照合へ載る
//   - 写真が Ostiarius のディスク (DB 以外) に残らない
//
// 2026-09-12: 承認・却下は Cernere ではなくローカル正本への操作になった
// (spec/plan/face-data-local-only.md §4)。

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { countFaceSubjectRows, listFaceTemplates, openDb } from '../server/db.ts';
import { loadLocalFaceKeys } from '../server/face/local-key.ts';
import { storeFacePhoto, storeFaceTemplate } from '../server/face/local-store.ts';
import { buildFaceRoster } from '../server/face/template-roster.ts';
import { EnrollmentSessionStore } from '../server/face/enrollment-session.ts';
import { FaceReviewService } from '../server/face/review-service.ts';
import { StaffSessionStore } from '../server/face/staff-session.ts';
import { makeIdentityReviewRouter } from '../server/routes/identity-review.ts';

const MODEL_ID = 'insightface/glintr100@1';
const originalFetch = globalThis.fetch;

function keys() {
  return loadLocalFaceKeys(mkdtempSync(join(tmpdir(), 'ostiarius-review-')));
}

function embedding(index: number): Float32Array {
  const value = new Float32Array(512);
  value[index] = 1;
  return value;
}

interface Harness {
  db: ReturnType<typeof openDb>;
  local: ReturnType<typeof keys>;
  staff: StaffSessionStore;
  enrollment: EnrollmentSessionStore;
  review: FaceReviewService;
  router: Hono;
}

function harness(options: { isLan?: boolean } = {}): Harness {
  const db = openDb(':memory:');
  const local = keys();
  const staff = new StaffSessionStore();
  const enrollment = new EnrollmentSessionStore();
  const review = new FaceReviewService({ db, keys: local, enrollment, modelId: MODEL_ID, facilityId: 'facility-1' });
  const router = new Hono();
  router.route('/', makeIdentityReviewRouter({
    db,
    staff,
    review,
    enrollment,
    cernereBaseUrl: 'https://cernere.example',
    serviceToken: async () => 'service-token',
    facilityId: 'facility-1',
    staffRoles: ['staff', 'admin'],
    shotsRequired: 6,
    consentSource: 'cernere',
    isLan: () => options.isLan ?? true,
  }));
  return { db, local, staff, enrollment, review, router };
}

/** 写真から作った pending (kiosk /enroll の写真アップロード後の状態)。 */
function seedPending(h: Harness, userId: string): void {
  storeFaceTemplate(h.db, h.local, {
    userId, facilityId: 'facility-1', template: embedding(1), modelId: MODEL_ID,
    quality: .5, state: 'pending', consentId: 'consent-1', enrolledBy: 'staff-1',
  });
  storeFacePhoto(h.db, h.local, {
    userId, facilityId: 'facility-1', bytes: Buffer.from([1, 2, 3]), contentType: 'image/jpeg', consentId: 'consent-1',
  });
}

function shoot(enrollment: EnrollmentSessionStore, userId: string, staffUserId: string): string {
  const enrollId = enrollment.start(userId, staffUserId);
  enrollment.consent(enrollId, 'consent-1');
  for (let index = 0; index < 6; index += 1) {
    enrollment.add(enrollId, Buffer.from(embedding(index).buffer).toString('base64'), 1);
  }
  return enrollId;
}

describe('photo-seeded enrollment review', () => {
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it('keeps pending templates out of the matcher', () => {
    const h = harness();
    seedPending(h, 'pending-user');
    storeFaceTemplate(h.db, h.local, {
      userId: 'active-user', facilityId: 'facility-1', template: embedding(2), modelId: MODEL_ID,
      quality: .9, state: 'active', consentId: 'consent-2', enrolledBy: 'staff-1',
    });
    expect(buildFaceRoster(h.db, h.local, MODEL_ID).userIds).toEqual(['active-user']);
  });

  it('refuses a rejection without a reason and deletes nothing', async () => {
    const h = harness();
    seedPending(h, 'student-1');
    const staffSession = h.staff.create('staff-1');
    const response = await h.router.request('/identity/review/reject', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ostiarius-staff': staffSession },
      body: JSON.stringify({ userId: 'student-1', reason: '   ' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'reason_required' });
    expect(countFaceSubjectRows(h.db, 'student-1').templates).toBe(1);

    const overlong = await h.router.request('/identity/review/reject', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ostiarius-staff': staffSession },
      body: JSON.stringify({ userId: 'student-1', reason: 'a'.repeat(257) }),
    });
    expect(overlong.status).toBe(400);
    expect(countFaceSubjectRows(h.db, 'student-1').templates).toBe(1);
  });

  it('deletes the photo and the pending template together on rejection', async () => {
    const h = harness();
    seedPending(h, 'student-1');
    const accepted = await h.router.request('/identity/review/reject', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ostiarius-staff': h.staff.create('staff-1') },
      body: JSON.stringify({ userId: 'student-1', reason: '他人の写真だった' }),
    });
    expect(accepted.status).toBe(200);
    expect(countFaceSubjectRows(h.db, 'student-1')).toEqual({ templates: 0, photos: 0, consents: 0 });
    const audit = h.db.prepare("SELECT reason, actor_user, subject_user FROM verification_events WHERE kind='photo_review'").get() as {
      reason: string; actor_user: string; subject_user: string;
    };
    expect(audit).toMatchObject({ reason: '他人の写真だった', actor_user: 'staff-1', subject_user: 'student-1' });
  });

  it('stores the re-enrolled template as active and puts it on the matcher at once', async () => {
    const h = harness();
    seedPending(h, 'student-1');
    const enrollId = shoot(h.enrollment, 'student-1', 'staff-1');
    await expect(h.review.approve({ userId: 'student-1', mode: 'reenroll', staffUserId: 'staff-1', enrollId }))
      .resolves.toEqual({ ok: true, mode: 'reenroll' });
    expect(listFaceTemplates(h.db, 'active').map((row) => row.user_id)).toEqual(['student-1']);
    expect(buildFaceRoster(h.db, h.local, MODEL_ID).userIds).toEqual(['student-1']);
    // 写真は承認後も職員の名簿表示のために残る (削除は失効・却下のときだけ)。
    expect(countFaceSubjectRows(h.db, 'student-1').photos).toBe(1);
  });

  it('promotes a photo-seeded pending template without new shots', async () => {
    const h = harness();
    seedPending(h, 'student-1');
    await expect(h.review.approve({ userId: 'student-1', mode: 'promote-photo', staffUserId: 'staff-1' }))
      .resolves.toEqual({ ok: true, mode: 'promote-photo' });
    expect(buildFaceRoster(h.db, h.local, MODEL_ID).userIds).toEqual(['student-1']);
  });

  it('rejects a promotion for a user without a pending template', async () => {
    const h = harness();
    await expect(h.review.approve({ userId: 'ghost', mode: 'promote-photo', staffUserId: 'staff-1' }))
      .resolves.toEqual({ ok: false, error: 'pending_not_found' });
  });

  it('rejects a re-enrollment approval that has too few shots', async () => {
    const h = harness();
    seedPending(h, 'student-1');
    const enrollId = h.enrollment.start('student-1', 'staff-1');
    h.enrollment.consent(enrollId, 'consent-1');
    h.enrollment.add(enrollId, Buffer.from(embedding(0).buffer).toString('base64'), 1);
    await expect(h.review.approve({ userId: 'student-1', mode: 'reenroll', staffUserId: 'staff-1', enrollId }))
      .resolves.toEqual({ ok: false, error: 'insufficient_shots' });
    expect(listFaceTemplates(h.db, 'active')).toHaveLength(0);
  });

  it('lists local pending candidates even when the Cernere roster is unavailable', async () => {
    const h = harness();
    seedPending(h, 'student-1');
    globalThis.fetch = (async () => new Response('{}', { status: 503 })) as typeof fetch;
    const response = await h.router.request('/identity/review/candidates', {
      headers: { 'x-ostiarius-staff': h.staff.create('staff-1') },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      candidates: [{ userId: 'student-1', hint: 'ID / -1', state: 'pending', hasPhoto: true }],
      rosterAvailable: false,
    });
  });

  it('adds unregistered roster members next to the pending ones', async () => {
    const h = harness();
    seedPending(h, 'student-1');
    globalThis.fetch = (async () => new Response(JSON.stringify({
      users: [
        { userId: 'student-1', hint: 'ID / -1', roles: [] },
        { userId: 'student-9', hint: 'ID / -9', roles: [] },
        { userId: 'staff-9', hint: 'ID / -9', roles: ['staff'] },
      ],
    }), { status: 200 })) as typeof fetch;
    const response = await h.router.request('/identity/review/candidates', {
      headers: { 'x-ostiarius-staff': h.staff.create('staff-1') },
    });
    const body = await response.json() as { candidates: Array<{ userId: string; state: string }>; rosterAvailable: boolean };
    expect(body.rosterAvailable).toBe(true);
    expect(body.candidates.map((candidate) => [candidate.userId, candidate.state])).toEqual([
      ['student-1', 'pending'],
      ['student-9', 'unregistered'],
    ]);
  });

  it('requires the student authCode for a re-enrollment session (consent needs the student token)', async () => {
    const h = harness();
    const token = h.staff.create('staff-1');
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ userId: 'other-student', accessToken: 'student-access', expiresIn: 900 }),
      { status: 200 },
    )) as typeof fetch;
    const start = async (body: unknown): Promise<Response> => h.router.request('/identity/review/reenroll/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ostiarius-staff': token },
      body: JSON.stringify(body),
    });
    // コード無しでは開始できない (service token で同意を代筆させないため)。
    expect((await start({ userId: 'student-1' })).status).toBe(401);
    // 交換結果が審査対象と別人なら 409。
    expect((await start({ userId: 'student-1', studentAuthCode: 'code-1' })).status).toBe(409);
  });

  it('requires a staff session for every review route', async () => {
    const h = harness();
    expect((await h.router.request('/identity/review/candidates')).status).toBe(401);
    for (const path of ['/identity/review/approve', '/identity/review/reject', '/identity/review/reenroll/start']) {
      const response = await h.router.request(path, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: 'student-1' }),
      });
      expect(response.status).toBe(401);
    }
  });

  it('refuses approval and rejection from outside the facility LAN', async () => {
    const h = harness({ isLan: false });
    seedPending(h, 'student-1');
    const token = h.staff.create('staff-1');
    for (const [path, body] of [
      ['/identity/review/approve', { userId: 'student-1', mode: 'promote-photo' }],
      ['/identity/review/reject', { userId: 'student-1', reason: 'テスト' }],
    ] as const) {
      const response = await h.router.request(path, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-ostiarius-staff': token }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(403);
    }
    expect(countFaceSubjectRows(h.db, 'student-1').templates).toBe(1);
  });
});
