// 顔登録 (enroll) の API — 職員立会い + 同意。
//
// 2026-09-12 (spec/plan/face-data-local-only.md §2 / §4):
//   - 抽出したテンプレートは Cernere へ PUT せず、**ローカル正本**へ封緘保存する。
//   - プロフィール顔写真のアップロード先は kiosk /enroll (LAN 内、職員セッション必須)。
//     写真から作るテンプレートは `pending` で、職員が承認するまで照合に載らない。
//   - 同意記録の正本は従来どおり Cernere (生徒 authCode → 本人 token)。写しをローカルにも
//     持ち、Cernere 不通時の照合可否判定に使う。
//   - kiosk 上での本人削除 (職員立会い) はローカル即時削除 + outbox で同意撤回を再送。
//
// 撮影フレーム・写真バイトはメモリ上でのみ扱う。ディスクへ書くのは封緘済み blob だけ。

import { Hono } from 'hono';
import type { Context } from 'hono';
import type Database from 'better-sqlite3';
import { recordFaceEvent } from '../db.ts';
import { averageEmbedding, EnrollmentSessionStore } from '../face/enrollment-session.ts';
import { decodeFaceEmbedding, type FaceSidecar } from '../face/sidecar-client.ts';
import type { StaffSessionStore } from '../face/staff-session.ts';
import { CernereConsentClient } from '../face/cernere-consent-client.ts';
import { enqueueConsentRevocation } from '../face/consent-outbox.ts';
import {
  FACE_CONSENT_FALLBACK_POLICY_VERSIONS,
  FACE_CONSENT_POLICY_VERSION,
  FACE_CONSENT_TEXT,
} from '../face/consent-policy.ts';
import type { LocalFaceKeys } from '../face/local-key.ts';
import { deleteFaceRegistration, storeFaceConsentCopy, storeFacePhoto, storeFaceTemplate } from '../face/local-store.ts';
import { resolveEnrollStudent } from '../face/student-auth-code.ts';
import type { ServiceTokenProvider } from '../cernere-service-token.ts';

const SHOTS_REQUIRED = 6;
const MAX_FRAME_BYTES = 200_000;
const MAX_PHOTO_BYTES = 2_000_000;
const PHOTO_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface IdentityEnrollDeps {
  db: Database.Database;
  sidecar: FaceSidecar;
  staff: StaffSessionStore;
  enrollment: EnrollmentSessionStore;
  /** ローカル正本の封緘鍵 (ホスト内生成)。 */
  keys: LocalFaceKeys;
  modelId: string;
  facilityId: string;
  /** 同意記録の相手。`local` は Cernere を使わない検証・オフライン運用向け。 */
  consentSource: 'cernere' | 'local';
  baseUrl: string;
  serviceToken: ServiceTokenProvider;
  /** 施設 LAN 内からの要求か (写真の授受と登録削除に要求する)。 */
  isLan: (c: Context) => boolean;
}

export function makeIdentityEnrollRouter(deps: IdentityEnrollDeps): Hono {
  const router = new Hono();
  const actorOf = (c: Context): string | null => deps.staff.get(c.req.header('x-ostiarius-staff'));

  router.post('/identity/enroll/start', async (c) => {
    const actor = actorOf(c); const body = await c.req.json().catch(() => null) as { studentAuthCode?: unknown } | null;
    if (!actor) return c.json({ error: 'staff_unauthorized' }, 401);
    const student = await resolveEnrollStudent(body?.studentAuthCode, deps);
    if (!student) return c.json({ error: 'student_auth_failed' }, 401);
    const enrollId = deps.enrollment.start(student.userId, actor, student.accessToken);
    return c.json({ enrollId, student: { userId: student.userId, hint: `ID / ${student.userId.slice(-2)}` }, consent: { policyVersion: FACE_CONSENT_POLICY_VERSION, text: FACE_CONSENT_TEXT }, shots: { required: SHOTS_REQUIRED } });
  });

  router.post('/identity/enroll/consent', async (c) => {
    const body = await c.req.json().catch(() => null) as { enrollId?: unknown; accepted?: unknown } | null;
    if (typeof body?.enrollId !== 'string' || body.accepted !== true) return c.json({ error: 'consent_required' }, 409);
    const actor = actorOf(c);
    if (!actor) return c.json({ error: 'staff_unauthorized' }, 401);
    const enrollment = deps.enrollment.get(body.enrollId);
    if (!enrollment) return c.json({ error: 'enroll_expired' }, 410);
    if (enrollment.staffUserId !== actor) return c.json({ error: 'enrollment_forbidden' }, 403);
    const consent = await recordConsent(enrollment.studentAccessToken, body.enrollId, deps);
    if (!consent || !deps.enrollment.consent(body.enrollId, consent.consentId)) return c.json({ error: 'consent_record_failed' }, 503);
    // 同意の写しをローカルにも残す (Cernere 不通でも 365 日判定ができるように)。
    storeFaceConsentCopy(deps.db, {
      userId: enrollment.studentUserId,
      consentId: consent.consentId,
      policyVersion: consent.policyVersion,
      at: consent.at,
    });
    return c.json({ ok: true, policyVersion: consent.policyVersion });
  });

  router.post('/identity/enroll/frame', async (c) => {
    const actor = actorOf(c);
    if (!actor) return c.json({ error: 'staff_unauthorized' }, 401);
    const body = await c.req.parseBody(); const enrollId = body.enrollId; const frame = body.frame;
    if (typeof enrollId !== 'string' || !(frame instanceof File) || frame.size > MAX_FRAME_BYTES) return c.json({ error: 'bad_request' }, 400);
    const enrollment = deps.enrollment.get(enrollId);
    if (!enrollment) return c.json({ error: 'enroll_expired' }, 410);
    if (enrollment.staffUserId !== actor) return c.json({ error: 'enrollment_forbidden' }, 403);
    const result = await deps.sidecar.embedBatch([Buffer.from(await frame.arrayBuffer()).toString('base64')]);
    const quality = result.qualities[0]; const accepted = deps.enrollment.add(enrollId, result.embeddings[0] ?? null, quality?.pass ? 1 : 0);
    const session = deps.enrollment.get(enrollId);
    return c.json({ accepted, hint: accepted ? 'accepted' : 'hold_still', shotsDone: session?.embeddings.length ?? 0, shotsRequired: SHOTS_REQUIRED });
  });

  /**
   * プロフィール顔写真 1 枚の受け取り (LAN 内、職員セッション必須)。
   * 写真はローカルに封緘保存し、そこから抽出した 512d は `pending` で保管する。
   * 抽出できない写真は **何も保存しない** (写真だけが残る状態を作らない)。
   */
  router.post('/identity/enroll/photo', async (c) => {
    const actor = actorOf(c);
    if (!actor) return c.json({ error: 'staff_unauthorized' }, 401);
    if (!deps.isLan(c)) return c.json({ error: 'lan_only' }, 403);
    const body = await c.req.parseBody();
    const enrollId = body.enrollId; const photo = body.photo;
    if (typeof enrollId !== 'string' || !(photo instanceof File)) return c.json({ error: 'bad_request' }, 400);
    if (photo.size > MAX_PHOTO_BYTES || !PHOTO_CONTENT_TYPES.has(photo.type)) return c.json({ error: 'unsupported_photo' }, 415);
    const enrollment = deps.enrollment.get(enrollId);
    if (!enrollment) return c.json({ error: 'enroll_expired' }, 410);
    if (enrollment.staffUserId !== actor) return c.json({ error: 'enrollment_forbidden' }, 403);
    if (!enrollment.consentId) return c.json({ error: 'consent_required' }, 409);

    const bytes = Buffer.from(await photo.arrayBuffer());
    const extracted = await deps.sidecar.embedBatch([bytes.toString('base64')]);
    const embedding = decodeFaceEmbedding(extracted.embeddings[0] ?? undefined);
    if (!embedding) return c.json({ error: 'no_face_in_photo' }, 422);
    const version = storeFaceTemplate(deps.db, deps.keys, {
      userId: enrollment.studentUserId,
      facilityId: deps.facilityId,
      template: embedding,
      modelId: deps.modelId,
      quality: extracted.qualities[0]?.pass ? 1 : 0,
      state: 'pending',
      consentId: enrollment.consentId,
      enrolledBy: actor,
    });
    storeFacePhoto(deps.db, deps.keys, {
      userId: enrollment.studentUserId,
      facilityId: deps.facilityId,
      bytes,
      contentType: photo.type,
      consentId: enrollment.consentId,
    });
    recordFaceEvent(deps.db, { kind: 'enroll', outcome: 'pending', method: 'photo', subjectUser: enrollment.studentUserId, actorUser: actor });
    return c.json({ ok: true, state: 'pending', version });
  });

  router.post('/identity/enroll/commit', async (c) => {
    const body = await c.req.json().catch(() => null) as { enrollId?: unknown } | null;
    if (typeof body?.enrollId !== 'string') return c.json({ error: 'bad_request' }, 400);
    const actor = actorOf(c);
    if (!actor) return c.json({ error: 'staff_unauthorized' }, 401);
    const session = deps.enrollment.get(body.enrollId);
    if (!session) return c.json({ error: 'enroll_expired' }, 410);
    if (session.staffUserId !== actor) return c.json({ error: 'enrollment_forbidden' }, 403);
    if (!session.consentId) return c.json({ error: 'consent_required' }, 409);
    const template = averageEmbedding(session.embeddings);
    if (!template) return c.json({ error: 'insufficient_shots' }, 409);
    const quality = session.qualities.length
      ? session.qualities.reduce((total, value) => total + value, 0) / session.qualities.length
      : 0;
    // 職員が実機で撮った登録は審査済み扱い = active (写真由来の pending とは別経路)。
    const version = storeFaceTemplate(deps.db, deps.keys, {
      userId: session.studentUserId,
      facilityId: deps.facilityId,
      template,
      modelId: deps.modelId,
      quality,
      state: 'active',
      consentId: session.consentId,
      enrolledBy: actor,
    });
    recordFaceEvent(deps.db, { kind: 'enroll', outcome: 'issued', subjectUser: session.studentUserId, actorUser: actor, reason: `shots:${session.embeddings.length}` });
    deps.enrollment.take(body.enrollId);
    return c.json({ ok: true, version });
  });

  /**
   * kiosk 上での登録削除 (生徒本人 + 職員立会い)。
   * ローカルは即時に物理削除し、Cernere への同意撤回は outbox で再送する
   * (Cernere 不通でも削除は完了させる — spec/interface/cernere-face-template.md §A)。
   */
  router.delete('/identity/enroll/registration/:userId', (c) => {
    const actor = actorOf(c);
    if (!actor) return c.json({ error: 'staff_unauthorized' }, 401);
    if (!deps.isLan(c)) return c.json({ error: 'lan_only' }, 403);
    const userId = c.req.param('userId');
    const removed = deleteFaceRegistration(deps.db, userId);
    if (!removed.templates && !removed.photos && !removed.consents) return c.json({ error: 'registration_not_found' }, 404);
    enqueueConsentRevocation(deps.db, { userId, consentId: null, revokedBy: actor });
    recordFaceEvent(deps.db, { kind: 'registration_delete', outcome: 'deleted', subjectUser: userId, actorUser: actor, reason: 'kiosk_self_delete' });
    return c.json({ ok: true, removed });
  });

  router.delete('/identity/enroll/:enrollId', (c) => {
    const enrollId = c.req.param('enrollId');
    const actor = actorOf(c);
    if (!actor) return c.json({ error: 'staff_unauthorized' }, 401);
    const enrollment = deps.enrollment.get(enrollId);
    if (!enrollment) return c.json({ error: 'enroll_expired' }, 410);
    if (enrollment.staffUserId !== actor) return c.json({ error: 'enrollment_forbidden' }, 403);
    deps.enrollment.cancel(enrollId);
    return c.json({ ok: true });
  });

  return router;
}

/** 同意を記録して consentId / 受理された policyVersion / 記録時刻を返す。 */
async function recordConsent(
  studentAccessToken: string | null,
  enrollId: string,
  deps: IdentityEnrollDeps,
): Promise<{ consentId: string; policyVersion: string; at: number } | null> {
  if (deps.consentSource === 'local') {
    return { consentId: `local:${enrollId}`, policyVersion: FACE_CONSENT_POLICY_VERSION, at: Date.now() };
  }
  if (!studentAccessToken) return null;
  const client = new CernereConsentClient({ baseUrl: deps.baseUrl, serviceToken: deps.serviceToken, facilityId: deps.facilityId });
  return client.recordConsent(studentAccessToken, [FACE_CONSENT_POLICY_VERSION, ...FACE_CONSENT_FALLBACK_POLICY_VERSIONS]);
}
