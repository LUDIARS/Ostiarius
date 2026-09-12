// プロフィール写真由来 pending テンプレートの職員審査 (承認 / 却下) — ローカル実行。
//
// spec/feature/face-photo-seeded-enrollment.md §3:
//   承認は 2 モード。既定は「追加ショットを撮って active を作り直す」(reenroll) —
//   1 枚の写真から作った pending をそのまま使うと誤拒否が増えるため。
//   もう一方は写真由来 pending をそのまま昇格する promote-photo。
//   却下は理由必須で、写真と pending が同時に消える。
//
// 2026-09-12 (spec/plan/face-data-local-only.md §4): 正本がローカルになったので
// Cernere への promote / reject / PUT は無い。active 化はローカルの state 遷移で、
// 照合 roster は次のフレームで即座に新しい state を読む (export 同期を待たない)。
//
// 誰が承認したかは Ostiarius の verification_events に actor として残る
// (kiosk でパスキー認証した職員本人)。

import type Database from 'better-sqlite3';
import { getFaceTemplate, recordFaceEvent } from '../db.ts';
import { averageEmbedding, type EnrollmentSessionStore } from './enrollment-session.ts';
import type { LocalFaceKeys } from './local-key.ts';
import { activateFaceTemplate, deleteFaceRegistration, storeFaceTemplate } from './local-store.ts';

export type PromoteMode = 'reenroll' | 'promote-photo';

export interface ReviewServiceDeps {
  db: Database.Database;
  /** ローカル正本の封緘鍵 (ホスト内生成)。 */
  keys: LocalFaceKeys;
  enrollment: EnrollmentSessionStore;
  modelId: string;
  facilityId: string;
}

export type ReviewFailure =
  | 'reason_required'
  | 'reason_too_long'
  | 'enrollment_required'
  | 'insufficient_shots'
  | 'pending_not_found';

export type ReviewResult = { ok: true; mode?: PromoteMode } | { ok: false; error: ReviewFailure };

export class FaceReviewService {
  constructor(private readonly deps: ReviewServiceDeps) {}

  /**
   * 承認。
   *   - 'reenroll'      : 撮り直したショットをローカル正本へ active で保存する。
   *   - 'promote-photo' : 写真由来 pending をそのまま active にする。
   */
  async approve(input: {
    userId: string;
    mode: PromoteMode;
    staffUserId: string;
    enrollId?: string;
  }): Promise<ReviewResult> {
    if (input.mode === 'reenroll') {
      const failure = this.storeReenrolledTemplate(input.userId, input.staffUserId, input.enrollId);
      if (failure) return { ok: false, error: failure };
    } else if (!activateFaceTemplate(this.deps.db, input.userId)) {
      return { ok: false, error: 'pending_not_found' };
    }
    recordFaceEvent(this.deps.db, {
      kind: 'photo_review',
      outcome: 'approved',
      method: input.mode,
      subjectUser: input.userId,
      actorUser: input.staffUserId,
      reason: input.mode,
    });
    return { ok: true, mode: input.mode };
  }

  /**
   * 却下。理由が空なら何も消さずに止める (理由の無い却下記録を作らない)。
   * 写真・pending・同意の写しは同時に消える (片方だけ残さない)。
   */
  async reject(input: { userId: string; reason: string; staffUserId: string }): Promise<ReviewResult> {
    const reason = input.reason.trim();
    if (!reason) return { ok: false, error: 'reason_required' };
    if (reason.length > 256) return { ok: false, error: 'reason_too_long' };
    const removed = deleteFaceRegistration(this.deps.db, input.userId);
    if (!removed.templates && !removed.photos) return { ok: false, error: 'pending_not_found' };
    recordFaceEvent(this.deps.db, {
      kind: 'photo_review',
      outcome: 'rejected',
      subjectUser: input.userId,
      actorUser: input.staffUserId,
      reason,
    });
    return { ok: true };
  }

  /** 撮り直したショットをローカル正本へ active で保存する。失敗理由を返す。 */
  private storeReenrolledTemplate(userId: string, staffUserId: string, enrollId?: string): ReviewFailure | null {
    if (!enrollId) return 'enrollment_required';
    const session = this.deps.enrollment.get(enrollId);
    if (!session || session.studentUserId !== userId || !session.consentId) return 'enrollment_required';
    const template = averageEmbedding(session.embeddings);
    if (!template) return 'insufficient_shots';
    const quality = session.qualities.length
      ? session.qualities.reduce((total, value) => total + value, 0) / session.qualities.length
      : 0;
    storeFaceTemplate(this.deps.db, this.deps.keys, {
      userId,
      facilityId: this.deps.facilityId,
      template,
      modelId: this.deps.modelId,
      quality,
      state: 'active',
      consentId: session.consentId,
      enrolledBy: staffUserId,
    });
    this.deps.enrollment.take(enrollId);
    return null;
  }

  /** 審査対象が pending として存在するか (route の 404 判定用)。 */
  hasPending(userId: string): boolean {
    return getFaceTemplate(this.deps.db, userId)?.state === 'pending';
  }
}
