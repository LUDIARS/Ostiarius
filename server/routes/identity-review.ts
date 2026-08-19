// 写真由来 pending テンプレートの職員審査 API (kiosk /enroll の承認パネル用)。
//
// spec/feature/face-photo-seeded-enrollment.md §3 / §4:
//   - 候補一覧 -> 選択した 1 人の写真を都度取得して表示 (private, no-store)
//   - 承認は reenroll (既定) / promote-photo、却下は理由必須
//   - どちらも職員 passkey 認可 (staff_override と同じ StaffSessionStore)
//   - 写真を出すのは職員の承認画面だけ。kiosk の一般画面には出さない。
//
// 写真バイトは応答としてのみ扱う。ディスクへ書かず、ログにも出さない。

import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { FACE_CONSENT_POLICY_VERSION, FACE_CONSENT_TEXT } from '../face/consent-policy.ts';
import type { CernerePhotoClient, PromoteMode } from '../face/cernere-photo-client.ts';
import type { EnrollmentSessionStore } from '../face/enrollment-session.ts';
import { isReviewCandidate, listReviewCandidates } from '../face/review-candidates.ts';
import { exchangeStudentAuthCode } from '../face/student-auth-code.ts';
import type { FaceReviewService } from '../face/review-service.ts';
import type { StaffSessionStore } from '../face/staff-session.ts';
import type { ServiceTokenProvider } from '../cernere-service-token.ts';

const PHOTO_HEADERS = {
  // 承認画面の写真はキャッシュさせない (biometric-data-policy §1.1)。
  'cache-control': 'private, no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

const PROMOTE_MODES: readonly PromoteMode[] = ['reenroll', 'promote-photo'];

/** 承認/却下の失敗理由に対応する HTTP status。 */
const FAILURE_STATUS: Record<string, 400 | 409 | 503> = {
  reason_required: 400,
  reason_too_long: 400,
  enrollment_required: 409,
  insufficient_shots: 409,
  template_store_failed: 503,
  promote_failed: 503,
  reject_failed: 503,
};

export interface IdentityReviewDeps {
  db: Database.Database;
  staff: StaffSessionStore;
  photos: CernerePhotoClient;
  review: FaceReviewService;
  enrollment: EnrollmentSessionStore;
  cernereBaseUrl: string;
  serviceToken: ServiceTokenProvider;
  facilityId: string;
  staffRoles: readonly string[];
  shotsRequired: number;
  /** テスト時は Cernere roster の代わりに候補認可を差し替えられる。 */
  isCandidate?: (userId: string) => Promise<boolean>;
}

export function makeIdentityReviewRouter(deps: IdentityReviewDeps): Hono {
  const router = new Hono();
  const actorOf = (token: string | undefined): string | null => deps.staff.get(token);
  const candidateOptions = {
    db: deps.db,
    baseUrl: deps.cernereBaseUrl,
    serviceToken: deps.serviceToken,
    facilityId: deps.facilityId,
    staffRoles: deps.staffRoles,
  };
  const hasCandidate = async (userId: string): Promise<'found' | 'absent' | 'unavailable'> => {
    try {
      const found = deps.isCandidate
        ? await deps.isCandidate(userId)
        : await isReviewCandidate(userId, candidateOptions);
      return found ? 'found' : 'absent';
    } catch {
      return 'unavailable';
    }
  };

  router.get('/identity/review/candidates', async (c) => {
    const actor = actorOf(c.req.header('x-ostiarius-staff'));
    if (!actor) return c.json({ error: 'staff_unauthorized' }, 401);
    try {
      const candidates = await listReviewCandidates({
        db: deps.db,
        baseUrl: deps.cernereBaseUrl,
        serviceToken: deps.serviceToken,
        facilityId: deps.facilityId,
        staffRoles: deps.staffRoles,
      });
      return c.json({ candidates }, 200, { 'cache-control': 'no-store' });
    } catch {
      return c.json({ error: 'roster_unavailable' }, 503);
    }
  });

  router.get('/identity/review/photo/:userId', async (c) => {
    const actor = actorOf(c.req.header('x-ostiarius-staff'));
    if (!actor) return c.json({ error: 'staff_unauthorized' }, 401);
    const candidate = await hasCandidate(c.req.param('userId'));
    if (candidate === 'unavailable') return c.json({ error: 'roster_unavailable' }, 503, PHOTO_HEADERS);
    if (candidate === 'absent') return c.json({ error: 'candidate_not_found' }, 404, PHOTO_HEADERS);
    const result = await deps.photos.fetchPhoto(c.req.param('userId'));
    if (result.kind === 'absent') return c.json({ error: 'photo_not_found' }, 404, PHOTO_HEADERS);
    if (result.kind === 'unavailable') return c.json({ error: 'photo_unavailable' }, 503, PHOTO_HEADERS);
    // Buffer をそのまま渡さず、ArrayBuffer 裏付けの Uint8Array へ写して返す。
    const bytes = Uint8Array.from(result.photo.bytes);
    return c.body(bytes, 200, { ...PHOTO_HEADERS, 'content-type': result.photo.contentType });
  });

  // 撮り直し承認の撮影セッション。ショット送信と同意記録は従来の enroll 経路
  // (/identity/enroll/consent, /identity/enroll/frame) をそのまま使う。
  router.post('/identity/review/reenroll/start', async (c) => {
    const actor = actorOf(c.req.header('x-ostiarius-staff'));
    if (!actor) return c.json({ error: 'staff_unauthorized' }, 401);
    const body = await c.req.json().catch(() => null) as { userId?: unknown; studentAuthCode?: unknown } | null;
    if (typeof body?.userId !== 'string' || !body.userId) return c.json({ error: 'bad_request' }, 400);
    const candidate = await hasCandidate(body.userId);
    if (candidate === 'unavailable') return c.json({ error: 'roster_unavailable' }, 503);
    if (candidate === 'absent') return c.json({ error: 'candidate_not_found' }, 404);
    // 撮り直しも同意記録を伴うため、生徒本人の authCode を要求する。
    // 同意は本人 token でしか記録できず、service token では代筆できない。
    const student = await exchangeStudentAuthCode(body.studentAuthCode, {
      baseUrl: deps.cernereBaseUrl, serviceToken: deps.serviceToken,
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
    const actor = actorOf(c.req.header('x-ostiarius-staff'));
    if (!actor) return c.json({ error: 'staff_unauthorized' }, 401);
    const body = await c.req.json().catch(() => null) as { userId?: unknown; mode?: unknown; enrollId?: unknown } | null;
    const mode = typeof body?.mode === 'string' ? body.mode : 'reenroll';
    if (typeof body?.userId !== 'string' || !body.userId || !PROMOTE_MODES.includes(mode as PromoteMode)) {
      return c.json({ error: 'bad_request' }, 400);
    }
    const candidate = await hasCandidate(body.userId);
    if (candidate === 'unavailable') return c.json({ error: 'roster_unavailable' }, 503);
    if (candidate === 'absent') return c.json({ error: 'candidate_not_found' }, 404);
    const result = await deps.review.approve({
      userId: body.userId,
      mode: mode as PromoteMode,
      staffUserId: actor,
      enrollId: typeof body.enrollId === 'string' ? body.enrollId : undefined,
    });
    if (!result.ok) return c.json({ error: result.error }, FAILURE_STATUS[result.error] ?? 503);
    return c.json({ ok: true, mode: result.mode });
  });

  router.post('/identity/review/reject', async (c) => {
    const actor = actorOf(c.req.header('x-ostiarius-staff'));
    if (!actor) return c.json({ error: 'staff_unauthorized' }, 401);
    const body = await c.req.json().catch(() => null) as { userId?: unknown; reason?: unknown } | null;
    if (typeof body?.userId !== 'string' || !body.userId) return c.json({ error: 'bad_request' }, 400);
    // 理由が無い却下は Cernere へ送る前にここで止める。
    if (typeof body.reason !== 'string' || !body.reason.trim()) return c.json({ error: 'reason_required' }, 400);
    if (body.reason.trim().length > 256) return c.json({ error: 'reason_too_long' }, 400);
    const candidate = await hasCandidate(body.userId);
    if (candidate === 'unavailable') return c.json({ error: 'roster_unavailable' }, 503);
    if (candidate === 'absent') return c.json({ error: 'candidate_not_found' }, 404);
    const result = await deps.review.reject({ userId: body.userId, reason: body.reason, staffUserId: actor });
    if (!result.ok) return c.json({ error: result.error }, FAILURE_STATUS[result.error] ?? 503);
    return c.json({ ok: true });
  });

  return router;
}
