// 職員立会い enroll の同意記録は「生徒本人の token」で打つ、という受け入れ条件。
//
// spec/interface/cernere-face-template.md §認証:
//   生徒本人の操作 (同意・撤回) は生徒の access token。kiosk は authCode を
//   POST /api/auth/code/exchange で交換して一時取得し、保存しない。
// service token で同意を代筆すると Cernere 側で他人の同意を作れてしまうため、
// ここで「どの Authorization で・どの body を送るか」を固定する。

import { Hono } from 'hono';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { openDb } from '../server/db.ts';
import { EnrollmentSessionStore } from '../server/face/enrollment-session.ts';
import { StaffSessionStore } from '../server/face/staff-session.ts';
import { makeIdentityEnrollRouter } from '../server/routes/identity-enroll.ts';
import type { FaceSidecar } from '../server/face/sidecar-client.ts';

const KEY = Buffer.alloc(32, 7);

interface Call { url: string; authorization: string; body: unknown }

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
      return new Response(JSON.stringify({ consentId: 'consent-1', at: 0 }), { status: 201 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
}

function enrollRouter(staff: StaffSessionStore, enrollment: EnrollmentSessionStore): Hono {
  const sidecar = { embedBatch: async () => ({ embeddings: [], qualities: [] }) } as unknown as FaceSidecar;
  const router = new Hono();
  router.route('/', makeIdentityEnrollRouter({
    db: openDb(':memory:'), sidecar, staff, enrollment, key: KEY,
    modelId: 'insightface/glintr100@1', source: 'cernere',
    baseUrl: 'https://cernere.example', serviceToken: 'service-token', facilityId: 'facility-1',
  }));
  return router;
}

async function startEnrollment(router: Hono, token: string, studentAuthCode = 'code-1'): Promise<Response> {
  return router.request('/identity/enroll/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ostiarius-staff': token },
    body: JSON.stringify({ studentAuthCode }),
  });
}

describe('職員立会い enroll の同意記録', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it('authCode を code/exchange で交換し、同意は生徒本人の token で打つ', async () => {
    const calls: Call[] = [];
    stubCernere(calls);
    const staff = new StaffSessionStore();
    const token = staff.create('staff-1');
    const router = enrollRouter(staff, new EnrollmentSessionStore());

    const started = await startEnrollment(router, token);
    expect(started.status).toBe(200);
    const { enrollId } = await started.json() as { enrollId: string };

    const consented = await router.request('/identity/enroll/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ostiarius-staff': token },
      body: JSON.stringify({ enrollId, accepted: true }),
    });
    expect(consented.status).toBe(200);

    const exchange = calls.find((call) => call.url.endsWith('/api/auth/code/exchange'));
    expect(exchange?.authorization).toBe('Bearer service-token');
    expect(exchange?.body).toEqual({ code: 'code-1' });

    const consent = calls.find((call) => call.url.endsWith('/api/identity/face-consent'));
    // service token ではなく交換で得た生徒の token を使う。
    expect(consent?.authorization).toBe('Bearer student-access');
    // 同意者は Authorization から決まるので userId は送らない (Cernere の schema は strict)。
    expect(consent?.body).toEqual({ policyVersion: expect.any(String), facilityId: 'facility-1' });
  });

  it('同意成立と同時に生徒 token を破棄する', async () => {
    stubCernere([]);
    const staff = new StaffSessionStore();
    const token = staff.create('staff-1');
    const enrollment = new EnrollmentSessionStore();
    const router = enrollRouter(staff, enrollment);

    const { enrollId } = await (await startEnrollment(router, token)).json() as { enrollId: string };
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
    const staff = new StaffSessionStore();
    const token = staff.create('staff-1');
    const router = enrollRouter(staff, new EnrollmentSessionStore());

    const started = await startEnrollment(router, token);
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
    const staff = new StaffSessionStore();
    const router = enrollRouter(staff, new EnrollmentSessionStore());

    const started = await startEnrollment(router, staff.create('staff-1'));
    expect(started.status).toBe(401);
    expect(await started.json()).toEqual({ error: 'student_auth_failed' });
  });
});
