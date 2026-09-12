// 職員立会い enroll の受け入れ条件。
//
// 同意記録 (spec/interface/cernere-face-template.md §A):
//   生徒本人の操作 (同意・撤回) は生徒の access token。kiosk は authCode を
//   POST /api/auth/code/exchange で交換して一時取得し、保存しない。
//   service token で同意を代筆すると Cernere 側で他人の同意を作れてしまうため、
//   ここで「どの Authorization で・どの body を送るか」を固定する。
//
// 保存 (spec/plan/face-data-local-only.md §2 / §4):
//   テンプレートと写真は Cernere へ送らず、ローカル正本へ封緘保存する。
//   写真の受け取りと登録削除は LAN 内 + 職員セッション必須。

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { countFaceSubjectRows, getFaceConsentCopy, getFacePhoto, getFaceTemplate, listDueOutbox, openDb } from '../server/db.ts';
import { EnrollmentSessionStore } from '../server/face/enrollment-session.ts';
import { loadLocalFaceKeys } from '../server/face/local-key.ts';
import { storeFacePhoto, storeFaceTemplate } from '../server/face/local-store.ts';
import { StaffSessionStore } from '../server/face/staff-session.ts';
import { makeIdentityEnrollRouter } from '../server/routes/identity-enroll.ts';
import { FACE_CONSENT_POLICY_VERSION } from '../server/face/consent-policy.ts';
import type { FaceSidecar } from '../server/face/sidecar-client.ts';

const MODEL_ID = 'insightface/glintr100@1';
const PHOTO = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);

interface Call { url: string; authorization: string; body: unknown }

function embedding(index: number): Float32Array {
  const value = new Float32Array(512);
  value[index] = 1;
  return value;
}

function stubCernere(calls: Call[], overrides: Record<string, () => Response> = {}): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      authorization: String((init?.headers as Record<string, string> | undefined)?.authorization ?? ''),
      body: JSON.parse(String(init?.body ?? '{}')),
    });
    const path = new URL(url).pathname;
    const override = overrides[path];
    if (override) return override();
    if (path === '/api/auth/code/exchange') {
      return new Response(JSON.stringify({ userId: 'student-1', accessToken: 'student-access', expiresIn: 900 }), { status: 200 });
    }
    if (path === '/api/identity/face-consent') {
      return new Response(JSON.stringify({ consentId: 'consent-1', at: 1_700_000_000_000 }), { status: 201 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
}

function sidecarStub(embeddings: Array<string | null>): FaceSidecar {
  return {
    embedBatch: async () => ({ embeddings, qualities: embeddings.map(() => ({ pass: true })) }),
  } as unknown as FaceSidecar;
}

function harness(options: { isLan?: boolean; sidecar?: FaceSidecar } = {}) {
  const db = openDb(':memory:');
  const keys = loadLocalFaceKeys(mkdtempSync(join(tmpdir(), 'ostiarius-enroll-')));
  const staff = new StaffSessionStore();
  const enrollment = new EnrollmentSessionStore();
  const router = new Hono();
  router.route('/', makeIdentityEnrollRouter({
    db,
    sidecar: options.sidecar ?? sidecarStub([]),
    staff,
    enrollment,
    keys,
    modelId: MODEL_ID,
    facilityId: 'facility-1',
    consentSource: 'cernere',
    baseUrl: 'https://cernere.example',
    serviceToken: async () => 'service-token',
    isLan: () => options.isLan ?? true,
  }));
  return { db, keys, staff, enrollment, router };
}

async function startEnrollment(router: Hono, token: string, studentAuthCode = 'code-1'): Promise<Response> {
  return router.request('/identity/enroll/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ostiarius-staff': token },
    body: JSON.stringify({ studentAuthCode }),
  });
}

async function consented(router: Hono, token: string): Promise<string> {
  const started = await startEnrollment(router, token);
  const { enrollId } = await started.json() as { enrollId: string };
  await router.request('/identity/enroll/consent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ostiarius-staff': token },
    body: JSON.stringify({ enrollId, accepted: true }),
  });
  return enrollId;
}

describe('職員立会い enroll の同意記録', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it('authCode を code/exchange で交換し、同意は生徒本人の token で打つ', async () => {
    const calls: Call[] = [];
    stubCernere(calls);
    const { staff, router, db } = harness();
    const token = staff.create('staff-1');
    await consented(router, token);

    const exchange = calls.find((call) => call.url.endsWith('/api/auth/code/exchange'));
    expect(exchange?.authorization).toBe('Bearer service-token');
    expect(exchange?.body).toEqual({ code: 'code-1' });

    const consent = calls.find((call) => call.url.endsWith('/api/identity/face-consent'));
    // service token ではなく交換で得た生徒の token を使う。
    expect(consent?.authorization).toBe('Bearer student-access');
    // 同意者は Authorization から決まるので userId は送らない (Cernere の schema は strict)。
    expect(consent?.body).toEqual({ policyVersion: FACE_CONSENT_POLICY_VERSION, facilityId: 'facility-1' });
    // 同意の写しをローカルにも残す (Cernere 不通時の 365 日判定に使う)。
    expect(getFaceConsentCopy(db, 'student-1')).toMatchObject({ consent_id: 'consent-1', policy_version: FACE_CONSENT_POLICY_VERSION });
  });

  it('Cernere が新しい policyVersion を知らなければ旧版へ落とす', async () => {
    const calls: Call[] = [];
    let attempt = 0;
    stubCernere(calls, {
      '/api/identity/face-consent': () => {
        attempt += 1;
        return attempt === 1
          ? new Response(JSON.stringify({ error: 'unknown policyVersion' }), { status: 400 })
          : new Response(JSON.stringify({ consentId: 'consent-legacy', at: 1 }), { status: 201 });
      },
    });
    const { staff, router, db } = harness();
    await consented(router, staff.create('staff-1'));

    const versions = calls
      .filter((call) => call.url.endsWith('/api/identity/face-consent'))
      .map((call) => (call.body as { policyVersion: string }).policyVersion);
    expect(versions).toEqual([FACE_CONSENT_POLICY_VERSION, 'face-template-v1']);
    expect(getFaceConsentCopy(db, 'student-1')?.policy_version).toBe('face-template-v1');
  });

  it('同意成立と同時に生徒 token を破棄する', async () => {
    stubCernere([]);
    const { staff, router, enrollment } = harness();
    const token = staff.create('staff-1');

    const started = await startEnrollment(router, token);
    const { enrollId } = await started.json() as { enrollId: string };
    expect(enrollment.get(enrollId)?.studentAccessToken).toBe('student-access');

    await router.request('/identity/enroll/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ostiarius-staff': token },
      body: JSON.stringify({ enrollId, accepted: true }),
    });
    expect(enrollment.get(enrollId)?.studentAccessToken).toBeNull();
  });

  it('accessToken を返さない交換応答は生徒認証失敗として扱う', async () => {
    stubCernere([], {
      '/api/auth/code/exchange': () => new Response(JSON.stringify({ userId: 'student-1' }), { status: 200 }),
    });
    const { staff, router } = harness();
    const started = await startEnrollment(router, staff.create('staff-1'));
    expect(started.status).toBe(401);
    expect(await started.json()).toEqual({ error: 'student_auth_failed' });
  });

  it('15 分以外の token は共有端末の enrollment session に保持しない', async () => {
    stubCernere([], {
      '/api/auth/code/exchange': () => new Response(
        JSON.stringify({ userId: 'student-1', accessToken: 'unexpected-long-lived-token', expiresIn: 86_400 }),
        { status: 200 },
      ),
    });
    const { staff, router } = harness();
    const started = await startEnrollment(router, staff.create('staff-1'));
    expect(started.status).toBe(401);
    expect(await started.json()).toEqual({ error: 'student_auth_failed' });
  });
});

describe('enroll のローカル保存', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it('撮影した 6 ショットを Cernere へ送らず active としてローカルへ封緘保存する', async () => {
    const calls: Call[] = [];
    stubCernere(calls);
    const { staff, router, db, keys } = harness({
      sidecar: sidecarStub([Buffer.from(embedding(1).buffer).toString('base64')]),
    });
    const token = staff.create('staff-1');
    const enrollId = await consented(router, token);
    for (let shot = 0; shot < 6; shot += 1) {
      const form = new FormData();
      form.set('enrollId', enrollId);
      form.set('frame', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), 'frame.jpg');
      await router.request('/identity/enroll/frame', { method: 'POST', headers: { 'x-ostiarius-staff': token }, body: form });
    }
    const committed = await router.request('/identity/enroll/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ostiarius-staff': token },
      body: JSON.stringify({ enrollId }),
    });
    expect(committed.status).toBe(200);

    const row = getFaceTemplate(db, 'student-1');
    expect(row).toMatchObject({ state: 'active', key_id: keys.template.keyId, consent_id: 'consent-1', enrolled_by: 'staff-1', facility_id: 'facility-1' });
    // テンプレートを運ぶ Cernere 呼び出しが 1 件も無い。
    expect(calls.filter((call) => call.url.includes('face-template'))).toHaveLength(0);
  });

  it('写真を受け取って pending テンプレートと封緘写真を保存する', async () => {
    stubCernere([]);
    const { staff, router, db, keys } = harness({
      sidecar: sidecarStub([Buffer.from(embedding(2).buffer).toString('base64')]),
    });
    const token = staff.create('staff-1');
    const enrollId = await consented(router, token);

    const form = new FormData();
    form.set('enrollId', enrollId);
    form.set('photo', new Blob([new Uint8Array(PHOTO)], { type: 'image/jpeg' }), 'photo.jpg');
    const response = await router.request('/identity/enroll/photo', {
      method: 'POST', headers: { 'x-ostiarius-staff': token }, body: form,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, state: 'pending' });

    expect(getFaceTemplate(db, 'student-1')?.state).toBe('pending');
    const photo = getFacePhoto(db, 'student-1');
    expect(photo?.key_id).toBe(keys.photo.keyId);
    // 写真の平文が列に入っていない。
    expect(photo?.photo_enc.includes(PHOTO)).toBe(false);
  });

  it('顔を検出できない写真は写真もテンプレートも保存しない', async () => {
    stubCernere([]);
    const { staff, router, db } = harness({ sidecar: sidecarStub([null]) });
    const token = staff.create('staff-1');
    const enrollId = await consented(router, token);

    const form = new FormData();
    form.set('enrollId', enrollId);
    form.set('photo', new Blob([new Uint8Array(PHOTO)], { type: 'image/jpeg' }), 'photo.jpg');
    const response = await router.request('/identity/enroll/photo', {
      method: 'POST', headers: { 'x-ostiarius-staff': token }, body: form,
    });
    expect(response.status).toBe(422);
    expect(countFaceSubjectRows(db, 'student-1')).toMatchObject({ templates: 0, photos: 0 });
  });

  it('同意前の写真は受け取らない', async () => {
    stubCernere([]);
    const { staff, router, db } = harness({
      sidecar: sidecarStub([Buffer.from(embedding(2).buffer).toString('base64')]),
    });
    const token = staff.create('staff-1');
    const started = await startEnrollment(router, token);
    const { enrollId } = await started.json() as { enrollId: string };

    const form = new FormData();
    form.set('enrollId', enrollId);
    form.set('photo', new Blob([new Uint8Array(PHOTO)], { type: 'image/jpeg' }), 'photo.jpg');
    const response = await router.request('/identity/enroll/photo', {
      method: 'POST', headers: { 'x-ostiarius-staff': token }, body: form,
    });
    expect(response.status).toBe(409);
    expect(countFaceSubjectRows(db, 'student-1')).toMatchObject({ templates: 0, photos: 0 });
  });

  it('施設 LAN の外からは写真を受け取らない', async () => {
    stubCernere([]);
    const { staff, router } = harness({
      isLan: false,
      sidecar: sidecarStub([Buffer.from(embedding(2).buffer).toString('base64')]),
    });
    const token = staff.create('staff-1');
    const enrollId = await consented(router, token);
    const form = new FormData();
    form.set('enrollId', enrollId);
    form.set('photo', new Blob([new Uint8Array(PHOTO)], { type: 'image/jpeg' }), 'photo.jpg');
    const response = await router.request('/identity/enroll/photo', {
      method: 'POST', headers: { 'x-ostiarius-staff': token }, body: form,
    });
    expect(response.status).toBe(403);
  });
});

describe('kiosk 上での登録削除', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  function enrolled(db: ReturnType<typeof openDb>, keys: ReturnType<typeof loadLocalFaceKeys>): void {
    storeFaceTemplate(db, keys, {
      userId: 'student-1', facilityId: 'facility-1', template: embedding(1), modelId: MODEL_ID,
      quality: 1, state: 'active', consentId: 'consent-1', enrolledBy: 'staff-1',
    });
    storeFacePhoto(db, keys, {
      userId: 'student-1', facilityId: 'facility-1', bytes: PHOTO, contentType: 'image/jpeg', consentId: 'consent-1',
    });
  }

  it('ローカルを即時削除し、Cernere への同意撤回を outbox へ積む', async () => {
    const { staff, router, db, keys } = harness();
    enrolled(db, keys);
    const response = await router.request('/identity/enroll/registration/student-1', {
      method: 'DELETE', headers: { 'x-ostiarius-staff': staff.create('staff-1') },
    });
    expect(response.status).toBe(200);
    expect(countFaceSubjectRows(db, 'student-1')).toEqual({ templates: 0, photos: 0, consents: 0 });
    const queued = listDueOutbox(db);
    expect(queued.map((row) => row.target)).toEqual(['cernere:face-consent-revoke']);
    expect(JSON.parse(queued[0]?.payload ?? '{}')).toMatchObject({ userId: 'student-1', revokedBy: 'staff-1' });
  });

  it('職員セッションと LAN の両方を要求する', async () => {
    const outside = harness({ isLan: false });
    enrolled(outside.db, outside.keys);
    expect((await outside.router.request('/identity/enroll/registration/student-1', { method: 'DELETE' })).status).toBe(401);
    const blocked = await outside.router.request('/identity/enroll/registration/student-1', {
      method: 'DELETE', headers: { 'x-ostiarius-staff': outside.staff.create('staff-1') },
    });
    expect(blocked.status).toBe(403);
    expect(countFaceSubjectRows(outside.db, 'student-1').templates).toBe(1);
  });
});
