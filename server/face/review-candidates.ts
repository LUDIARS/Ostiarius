// 審査候補 (= 写真由来 pending かもしれない生徒) の一覧。
//
// Cernere には pending テンプレートの一覧 API が無い
// (GET /api/identity/face-template/status は生徒本人 token 限定 —
//  Cernere/server/src/http/face-template-handler.ts:59)。
// export は state='active' しか返さない (face-template-store.ts:179) ので、
//   施設名簿 (GET /api/identity/roster) − ローカルキャッシュの active
// が「まだ出席照合に載っていない生徒」= 審査候補になる。
//
// 「審査待ち (写真あり)」か「未登録 (写真なし)」かは、職員が 1 人を選んだ時点の
// 写真取得結果で決まる。名簿一覧で全員分の写真を取りに行かない
// (spec/feature/face-photo-seeded-enrollment.md §4: 一括取得の口は作らない)。

import type Database from 'better-sqlite3';
import { listFaceTemplates } from '../db.ts';
import type { ServiceTokenProvider } from '../cernere-service-token.ts';

export interface ReviewCandidate {
  userId: string;
  /** 氏名フルは出さない (kiosk と同じ弱識別 hint)。 */
  hint: string;
}

export interface ReviewCandidateOptions {
  db: Database.Database;
  baseUrl: string;
  /** roster は export と同じ service token で読む。 */
  serviceToken: ServiceTokenProvider;
  facilityId: string;
  /** 職員 role は候補から外す。 */
  staffRoles: readonly string[];
  limit?: number;
}

interface RosterUser {
  userId?: unknown;
  hint?: unknown;
  roles?: unknown;
}

const DEFAULT_LIMIT = 200;

function isRosterUser(value: unknown): value is RosterUser {
  return typeof value === 'object' && value !== null;
}

function rolesOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((role): role is string => typeof role === 'string') : [];
}

function reviewCandidate(user: RosterUser, enrolled: ReadonlySet<string>, staffRoles: readonly string[]): ReviewCandidate | null {
  if (typeof user.userId !== 'string' || !user.userId) return null;
  if (enrolled.has(user.userId)) return null;
  if (rolesOf(user.roles).some((role) => staffRoles.includes(role))) return null;
  return {
    userId: user.userId,
    hint: typeof user.hint === 'string' && user.hint ? user.hint : `ID / ${user.userId.slice(-2)}`,
  };
}

async function rosterUsers(options: ReviewCandidateOptions): Promise<RosterUser[]> {
  const url = new URL('/api/identity/roster', options.baseUrl);
  url.searchParams.set('facilityId', options.facilityId);
  const response = await fetch(url, { headers: { authorization: `Bearer ${await options.serviceToken()}` } });
  if (!response.ok) throw new Error(`roster failed: HTTP ${response.status}`);
  const body = await response.json() as { users?: unknown };
  return Array.isArray(body.users) ? body.users.filter(isRosterUser) : [];
}

/** Cernere 名簿から、まだ active テンプレートを持たない生徒を返す。 */
export async function listReviewCandidates(options: ReviewCandidateOptions): Promise<ReviewCandidate[]> {
  const users = await rosterUsers(options);
  const enrolled = new Set(listFaceTemplates(options.db).map((row) => row.user_id));
  const candidates: ReviewCandidate[] = [];
  for (const user of users) {
    const candidate = reviewCandidate(user, enrolled, options.staffRoles);
    if (!candidate) continue;
    candidates.push(candidate);
    if (candidates.length >= (options.limit ?? DEFAULT_LIMIT)) break;
  }
  return candidates;
}

/**
 * 写真取得・審査の対象を施設の現在の候補へ限定する。
 * UI は候補一覧を出すだけなので、API を直接呼ばれても他施設または職員の
 * userId を scope 付き Cernere token へ渡さないための認可境界になる。
 */
export async function isReviewCandidate(userId: string, options: ReviewCandidateOptions): Promise<boolean> {
  const enrolled = new Set(listFaceTemplates(options.db).map((row) => row.user_id));
  for (const user of await rosterUsers(options)) {
    const candidate = reviewCandidate(user, enrolled, options.staffRoles);
    if (candidate?.userId === userId) return true;
  }
  return false;
}
