import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { recordFaceEvent, upsertFaceTemplate } from '../db.ts';
import { averageEmbedding, EnrollmentSessionStore } from '../face/enrollment-session.ts';
import type { FaceSidecar } from '../face/sidecar-client.ts';
import type { StaffSessionStore } from '../face/staff-session.ts';
import { CernereTemplateClient } from '../face/cernere-template-client.ts';
import { FACE_CONSENT_POLICY_VERSION, FACE_CONSENT_TEXT } from '../face/consent-policy.ts';
import { exchangeStudentAuthCode, type ResolvedStudent } from '../face/student-auth-code.ts';
export function makeIdentityEnrollRouter(deps: { db: Database.Database; sidecar: FaceSidecar; staff: StaffSessionStore; enrollment: EnrollmentSessionStore; key: Buffer; modelId: string; source: 'cernere' | 'local'; baseUrl: string; serviceToken: string; facilityId: string }): Hono {
  const router = new Hono();
  router.post('/identity/enroll/start', async (c) => {
    const actor = deps.staff.get(c.req.header('x-ostiarius-staff')); const body = await c.req.json().catch(() => null) as { studentAuthCode?: unknown } | null;
    if (!actor) return c.json({ error: 'staff_unauthorized' }, 401);
    const student = await resolveStudent(body?.studentAuthCode, deps);
    if (!student) return c.json({ error: 'student_auth_failed' }, 401);
    const enrollId = deps.enrollment.start(student.userId, actor, student.accessToken);
    return c.json({ enrollId, student: { userId: student.userId, hint: `ID / ${student.userId.slice(-2)}` }, consent: { policyVersion: FACE_CONSENT_POLICY_VERSION, text: FACE_CONSENT_TEXT }, shots: { required: 6 } });
  });
  router.post('/identity/enroll/consent', async (c) => {
    const body = await c.req.json().catch(() => null) as { enrollId?: unknown; accepted?: unknown } | null;
    if (typeof body?.enrollId !== 'string' || body.accepted !== true) return c.json({ error: 'consent_required' }, 409);
    const actor = deps.staff.get(c.req.header('x-ostiarius-staff'));
    if (!actor) return c.json({ error: 'staff_unauthorized' }, 401);
    const enrollment = deps.enrollment.get(body.enrollId);
    if (!enrollment) return c.json({ error: 'enroll_expired' }, 410);
    if (enrollment.staffUserId !== actor) return c.json({ error: 'enrollment_forbidden' }, 403);
    const consentId = deps.source === 'local'
      ? `local:${body.enrollId}`
      : await recordConsent(enrollment.studentAccessToken, deps);
    if (!consentId || !deps.enrollment.consent(body.enrollId, consentId)) return c.json({ error: 'consent_record_failed' }, 503);
    return c.json({ ok: true });
  });
  router.post('/identity/enroll/frame', async (c) => {
    const staffToken = c.req.header('x-ostiarius-staff');
    const actor = deps.staff.get(staffToken);
    if (!actor) return c.json({ error: 'staff_unauthorized' }, 401);
    const body = await c.req.parseBody(); const enrollId = body.enrollId; const frame = body.frame;
    if (typeof enrollId !== 'string' || !(frame instanceof File) || frame.size > 200_000) return c.json({ error: 'bad_request' }, 400);
    const enrollment = deps.enrollment.get(enrollId);
    if (!enrollment) return c.json({ error: 'enroll_expired' }, 410);
    if (enrollment.staffUserId !== actor) return c.json({ error: 'enrollment_forbidden' }, 403);
    const result = await deps.sidecar.embedBatch([Buffer.from(await frame.arrayBuffer()).toString('base64')]);
    const quality = result.qualities[0]; const accepted = deps.enrollment.add(enrollId, result.embeddings[0] ?? null, quality?.pass ? 1 : 0);
    const session = deps.enrollment.get(enrollId);
    return c.json({ accepted, hint: accepted ? 'accepted' : 'hold_still', shotsDone: session?.embeddings.length ?? 0, shotsRequired: 6 });
  });
  router.post('/identity/enroll/commit', async (c) => {
    const body = await c.req.json().catch(() => null) as { enrollId?: unknown } | null;
    if (typeof body?.enrollId !== 'string') return c.json({ error: 'bad_request' }, 400);
    const actor = deps.staff.get(c.req.header('x-ostiarius-staff'));
    if (!actor) return c.json({ error: 'staff_unauthorized' }, 401);
    const session = deps.enrollment.get(body.enrollId);
    if (!session) return c.json({ error: 'enroll_expired' }, 410);
    if (session.staffUserId !== actor) return c.json({ error: 'enrollment_forbidden' }, 403);
    const template = averageEmbedding(session.embeddings);
    if (!session || !template) return c.json({ error: 'insufficient_shots' }, 409);
    const version = Date.now();
    if (deps.source === 'cernere') {
      const stored = await templates(deps).putTemplate({ userId: session.studentUserId, template, modelId: deps.modelId, quality: session.qualities.reduce((a, b) => a + b, 0) / session.qualities.length, enrolledBy: session.staffUserId, consentId: session.consentId ?? '' });
      if (!stored) return c.json({ error: 'template_store_failed' }, 503);
    }
    upsertFaceTemplate(deps.db, { userId: session.studentUserId, template, modelId: deps.modelId, quality: 1, enrolledAt: Date.now(), version, key: deps.key });
    recordFaceEvent(deps.db, { kind: 'enroll', outcome: 'issued', subjectUser: session.studentUserId, reason: `shots:${session.embeddings.length}` });
    deps.enrollment.take(body.enrollId);
    return c.json({ ok: true, version });
  });
  router.delete('/identity/enroll/:enrollId', (c) => {
    const enrollId = c.req.param('enrollId');
    const actor = deps.staff.get(c.req.header('x-ostiarius-staff'));
    if (!actor) return c.json({ error: 'staff_unauthorized' }, 401);
    const enrollment = deps.enrollment.get(enrollId);
    if (!enrollment) return c.json({ error: 'enroll_expired' }, 410);
    if (enrollment.staffUserId !== actor) return c.json({ error: 'enrollment_forbidden' }, 403);
    deps.enrollment.cancel(enrollId);
    return c.json({ ok: true });
  });
  return router;
}
async function resolveStudent(value: unknown, deps: { source: 'cernere' | 'local'; baseUrl: string; serviceToken: string }): Promise<ResolvedStudent | null> {
  if (deps.source === 'local') {
    const userId = typeof value === 'string' && value.startsWith('local:') ? value.slice(6) : '';
    return userId ? { userId, accessToken: null } : null;
  }
  return exchangeStudentAuthCode(value, deps);
}

function templates(deps: { baseUrl: string; serviceToken: string; facilityId: string }): CernereTemplateClient {
  return new CernereTemplateClient({ baseUrl: deps.baseUrl, serviceToken: deps.serviceToken, facilityId: deps.facilityId });
}

async function recordConsent(studentAccessToken: string | null, deps: { baseUrl: string; serviceToken: string; facilityId: string }): Promise<string | null> {
  if (!studentAccessToken) return null;
  return templates(deps).recordConsent(studentAccessToken, FACE_CONSENT_POLICY_VERSION);
}
