// 写真由来 pending テンプレートの職員審査 API (kiosk /enroll の承認パネル用)。
//
// spec/feature/face-photo-seeded-enrollment.md §3 / §4:
//   - 候補一覧 -> 選択した 1 人の写真を都度取得して表示 (private, no-store)
//   - 承認は reenroll (既定) / promote-photo、却下は理由必須
//   - どちらも職員 passkey 認可 (staff_override と同じ StaffSessionStore)
//   - 写真を出すのは職員の承認画面だけ。kiosk の一般画面には出さない。
//
// 2026-09-12 (spec/plan/face-data-local-only.md §4): 承認・却下はローカル正本への
// 操作になり、Cernere の promote / reject は無くなった。写真の取得は職員向けの
// `GET /identity/face-photo/:userId` (routes/identity-staff.ts) に一本化した。

import { Hono } from 'hono';
import type { Context } from 'hono';
import type Database from 'better-sqlite3';
import {
  FACE_CONSENT_POLICY_VERSION,
  FACE_CONSENT_TEXT,
} from '../face/consent-policy.ts';
import type { EnrollmentSessionStore } from '../face/enrollment-session.ts';
import { listReviewCandidates } from '../face/review-candidates.ts';
import { resolveEnrollStudent } from '../face/student-auth-code.ts';
import type { FaceReviewService, PromoteMode } from '../face/review-service.ts';
import type { StaffSessionStore } from '../face/staff-session.ts';
import type { ServiceTokenProvider } from '../cernere-service-token.ts';

const PROMOTE_MODES: readonly PromoteMode[] = ['reenroll', 'promote-photo'];

/** 承認/却下の失敗理由に対応する HTTP status。 */
const FAILURE_STATUS: Record<string, 400 | 404 | 409> = {
  reason_required: 400,
  reason_too_long: 400,
  enrollment_required: 409,
  insufficient_shots: 409,
  pending_not_found: 404,
};

export interface IdentityReviewDeps {
  db: Database.Database;
  staff: StaffSessionStore;
  review: FaceReviewService;
  enrollment: EnrollmentSessionStore;
  cernereBaseUrl: string;
  serviceToken: ServiceTokenProvider;
  facilityId: string;
  staffRoles: readonly string[];
  shotsRequired: number;
  /** 同意記録の相手 (`local` は Cernere を使わない)。 */
  consentSource: 'cernere' | 'local';
  /** 施設 LAN 内からの要求か。 */
  isLan: (c: Context) => boolean;
}

export function makeIdentityReviewRouter(deps: IdentityReviewDeps): Hono {
  const router = new Hono();
  const actorOf = (c: Context): string | null => deps.staff.get(c.req.header('x-ostiarius-staff'));
  const candidateOptions = {
    db: deps.db,
    baseUrl: deps.cernereBaseUrl,
    serviceToken: deps.serviceToken,
    facilityId: deps.facilityId,
    staffRoles: deps.staffRoles,
  };

  router.get('/identity/review/candidates', async (c) => {
    const actor = actorOf(c);
    if (!actor) return c.json({ error: 'staff_unauthorized' }, 401);
    // 名簿が引けなくても審査待ち (ローカル pending) は出す。
    const { candidates, rosterAvailable } = await listReviewCandidates(candidateOptions);
    return c.json({ candidates, rosterAvailable }, 200, { 'cache-control': 'no-store' });
  });

  // 撮り直し承認の撮影セッション。ショット送信と同意記録は従来の enroll 経路
  // (/identity/enroll/consent, /identity/enroll/frame) をそのまま使う。
  router.post('/identity/review/reenroll/start', async (c) => {
    const actor = actorOf(c);
    if (!actor) return c.json({ error: 'staff_unauthorized' }, 401);
    const body = await c.req.json().catch(() => null) as { userId?: unknown; studentAuthCode?: unknown } | null;
    if (typeof body?.userId !== 'string' || !body.userId) return c.json({ error: 'bad_request' }, 400);
    // 撮り直しも同意記録を伴うため、生徒本人の authCode を要求する。
    // 同意は本人 token でしか記録できず、service token では代筆できない。
    const student = await resolveEnrollStudent(body.studentAuthCode, {
      baseUrl: deps.cernereBaseUrl, serviceToken: deps.serviceToken, consentSource: deps.consentSource,
    });
    if (!student) return c.json({ error: 'student_auth_failed' }, 401);
    if (student.userId !== body.userId) return c.json({ error: 'student_mismatch' }, 409);
    const enrollId = deps.enrollment.start(body.userId, actor, student.accessToken);
    return c.json({
      enrollId,
      consent: { policyVersion: FACE_CONSENT_POLICY_VERSION, text: FACE_CONSENT_TEXT },
      shots: { required: deps.shotsRequired },
    });
  });

  router.post('/identity/review/approve', async (c) => {
    const actor = actorOf(c);
    if (!actor) return c.json({ error: 'staff_unauthorized' }, 401);
    if (!deps.isLan(c)) return c.json({ error: 'lan_only' }, 403);
    const body = await c.req.json().catch(() => null) as { userId?: unknown; mode?: unknown; enrollId?: unknown } | null;
    const mode = typeof body?.mode === 'string' ? body.mode : 'reenroll';
    if (typeof body?.userId !== 'string' || !body.userId || !PROMOTE_MODES.includes(mode as PromoteMode)) {
      return c.json({ error: 'bad_request' }, 400);
    }
    const result = await deps.review.approve({
      userId: body.userId,
      mode: mode as PromoteMode,
      staffUserId: actor,
      enrollId: typeof body.enrollId === 'string' ? body.enrollId : undefined,
    });
    if (!result.ok) return c.json({ error: result.error }, FAILURE_STATUS[result.error] ?? 409);
    return c.json({ ok: true, mode: result.mode });
  });

  router.post('/identity/review/reject', async (c) => {
    const actor = actorOf(c);
    if (!actor) return c.json({ error: 'staff_unauthorized' }, 401);
    if (!deps.isLan(c)) return c.json({ error: 'lan_only' }, 403);
    const body = await c.req.json().catch(() => null) as { userId?: unknown; reason?: unknown } | null;
    if (typeof body?.userId !== 'string' || !body.userId) return c.json({ error: 'bad_request' }, 400);
    // 理由が無い却下は何も消す前にここで止める。
    if (typeof body.reason !== 'string' || !body.reason.trim()) return c.json({ error: 'reason_required' }, 400);
    if (body.reason.trim().length > 256) return c.json({ error: 'reason_too_long' }, 400);
    const result = await deps.review.reject({ userId: body.userId, reason: body.reason, staffUserId: actor });
    if (!result.ok) return c.json({ error: result.error }, FAILURE_STATUS[result.error] ?? 409);
    return c.json({ ok: true });
  });

  return router;
}
