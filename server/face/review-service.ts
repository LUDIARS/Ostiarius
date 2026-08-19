// プロフィール写真由来 pending テンプレートの職員審査 (承認 / 却下)。
//
// spec/feature/face-photo-seeded-enrollment.md §3:
//   承認は 2 モード。既定は「追加ショットを撮って active を作り直す」(reenroll) —
//   1 枚の写真から作った pending をそのまま使うと誤拒否が増えるため。
//   もう一方は写真由来 pending をそのまま昇格する promote-photo。
//   却下は理由必須で、写真と pending が同時に消える。
//
// reenroll の順序は Cernere 側の制約で決まっている
// (Cernere/server/src/identity/face-photo-store.ts:287-292):
//   PUT face-template (= state を active にする) -> promote(mode='reenroll')。
//   promote は「現行行が active であること」を要求するため、逆順では 409 になる。
//
// 誰が承認したかは 2 箇所に残る:
//   - Cernere: enrolledBy = 施設の審査者 userId (token の主体と一致必須。
//     Cernere/server/src/http/face-photo-handler.ts:104-116)
//   - Ostiarius: face_events の actorUser = kiosk でパスキー認証した職員本人

import type Database from 'better-sqlite3';
import { recordFaceEvent, upsertFaceTemplate } from '../db.ts';
import { averageEmbedding, type EnrollmentSessionStore } from './enrollment-session.ts';
import type { CernerePhotoClient, PromoteMode } from './cernere-photo-client.ts';
import type { CernereTemplateClient } from './cernere-template-client.ts';

export interface ReviewServiceDeps {
  db: Database.Database;
  photos: CernerePhotoClient;
  templates: CernereTemplateClient;
  enrollment: EnrollmentSessionStore;
  /** ローカル施設キャッシュの暗号化鍵。 */
  key: Buffer;
  modelId: string;
  /** Cernere 上の審査者 userId (PUT / promote / reject の enrolledBy)。 */
  reviewerUserId: string;
  /** active 化直後に Cernere 全量 export を取り直して施設キャッシュへ反映する。 */
  syncNow: () => Promise<unknown>;
}

export type ReviewFailure =
  | 'reason_required'
  | 'reason_too_long'
  | 'enrollment_required'
  | 'insufficient_shots'
  | 'template_store_failed'
  | 'promote_failed'
  | 'reject_failed';

export type ReviewResult = { ok: true; mode?: PromoteMode } | { ok: false; error: ReviewFailure };

export class FaceReviewService {
  constructor(private readonly deps: ReviewServiceDeps) {}

  /**
   * 承認。
   *   - 'reenroll'      : 撮り直したショットを Cernere へ登録 (= active) してから promote。
   *                       ローカルキャッシュへも即時 upsert する。
   *   - 'promote-photo' : 写真由来 pending をそのまま active にし、export を取り直して反映する。
   */
  async approve(input: {
    userId: string;
    mode: PromoteMode;
    staffUserId: string;
    enrollId?: string;
  }): Promise<ReviewResult> {
    if (input.mode === 'reenroll') {
      const failure = await this.publishReenrolledTemplate(input.userId, input.enrollId);
      if (failure) return { ok: false, error: failure };
    }
    if (!await this.deps.photos.promote(input.userId, input.mode)) {
      return { ok: false, error: 'promote_failed' };
    }
    // active になった時点で施設キャッシュへ即時反映する (次の定期 sync を待たない)。
    await this.deps.syncNow();
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

  /** 却下。理由が空なら Cernere を呼ぶ前に止める (理由の無い却下記録を作らない)。 */
  async reject(input: { userId: string; reason: string; staffUserId: string }): Promise<ReviewResult> {
    const reason = input.reason.trim();
    if (!reason) return { ok: false, error: 'reason_required' };
    if (reason.length > 256) return { ok: false, error: 'reason_too_long' };
    if (!await this.deps.photos.reject(input.userId, reason)) {
      return { ok: false, error: 'reject_failed' };
    }
    recordFaceEvent(this.deps.db, {
      kind: 'photo_review',
      outcome: 'rejected',
      subjectUser: input.userId,
      actorUser: input.staffUserId,
      reason,
    });
    return { ok: true };
  }

  /** 撮り直したショットを Cernere とローカルキャッシュへ反映する。失敗理由を返す。 */
  private async publishReenrolledTemplate(userId: string, enrollId?: string): Promise<ReviewFailure | null> {
    if (!enrollId) return 'enrollment_required';
    const session = this.deps.enrollment.get(enrollId);
    if (!session || session.studentUserId !== userId || !session.consentId) return 'enrollment_required';
    const template = averageEmbedding(session.embeddings);
    if (!template) return 'insufficient_shots';
    const quality = session.qualities.length
      ? session.qualities.reduce((total, value) => total + value, 0) / session.qualities.length
      : 0;
    const stored = await this.deps.templates.putTemplate({
      userId,
      template,
      modelId: this.deps.modelId,
      quality,
      enrolledBy: this.deps.reviewerUserId,
      consentId: session.consentId,
    });
    if (!stored) return 'template_store_failed';
    upsertFaceTemplate(this.deps.db, {
      userId,
      template,
      modelId: this.deps.modelId,
      quality: 1,
      enrolledAt: Date.now(),
      version: Date.now(),
      key: this.deps.key,
    });
    this.deps.enrollment.take(enrollId);
    return null;
  }
}
