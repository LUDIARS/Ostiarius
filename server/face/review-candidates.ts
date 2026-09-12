// 審査候補 (= 写真由来 pending を持つ生徒 / まだ登録していない生徒) の一覧。
//
// 2026-09-12 (spec/plan/face-data-local-only.md §4): 写真と pending テンプレートの正本が
// ローカルになったので、「審査待ち」はローカルの `state='pending'` 行そのもの。
// Cernere に問い合わせる必要があるのは「まだ何も登録していない生徒」を出すときだけで、
// 名簿 (`GET /api/identity/roster`) が引けなくても審査待ちの一覧は出せる
// (Cernere 不通でも職員が承認を進められるようにする)。
//
// 氏名フルは出さない (kiosk と同じ弱識別 hint)。

import type Database from 'better-sqlite3';
import { listFaceTemplates, listFacePhotoUserIds } from '../db.ts';
import type { ServiceTokenProvider } from '../cernere-service-token.ts';

export type ReviewCandidateState = 'pending' | 'unregistered';

export interface ReviewCandidate {
  userId: string;
  /** 氏名フルは出さない (kiosk と同じ弱識別 hint)。 */
  hint: string;
  state: ReviewCandidateState;
  /** 審査画面に写真を出せるか。 */
  hasPhoto: boolean;
}

export interface ReviewCandidateOptions {
  db: Database.Database;
  baseUrl: string;
  /** 名簿は passkey export と同じ service token で読む。 */
  serviceToken: ServiceTokenProvider;
  facilityId: string;
  /** 職員 role は候補から外す。 */
  staffRoles: readonly string[];
  limit?: number;
}

export interface ReviewCandidateList {
  candidates: ReviewCandidate[];
  /** Cernere 名簿を引けたか (引けないと「未登録」の行が出ない)。 */
  rosterAvailable: boolean;
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

function hintOf(userId: string, hint?: unknown): string {
  return typeof hint === 'string' && hint ? hint : `ID / ${userId.slice(-2)}`;
}

async function rosterUsers(options: ReviewCandidateOptions): Promise<RosterUser[]> {
  const url = new URL('/api/identity/roster', options.baseUrl);
  url.searchParams.set('facilityId', options.facilityId);
  const response = await fetch(url, { headers: { authorization: `Bearer ${await options.serviceToken()}` } });
  if (!response.ok) throw new Error(`roster failed: HTTP ${response.status}`);
  const body = await response.json() as { users?: unknown };
  return Array.isArray(body.users) ? body.users.filter(isRosterUser) : [];
}

/** ローカルの `pending` (写真由来の申請) — Cernere 不通でもこれは出せる。 */
function pendingCandidates(db: Database.Database): ReviewCandidate[] {
  const withPhoto = new Set(listFacePhotoUserIds(db));
  return listFaceTemplates(db, 'pending').map((row) => ({
    userId: row.user_id,
    hint: hintOf(row.user_id),
    state: 'pending' as const,
    hasPhoto: withPhoto.has(row.user_id),
  }));
}

/**
 * 審査待ち (ローカル pending) と、まだ登録の無い生徒 (Cernere 名簿 − ローカル登録) を返す。
 * 名簿が引けないときは審査待ちだけを返し、`rosterAvailable: false` で知らせる。
 */
export async function listReviewCandidates(options: ReviewCandidateOptions): Promise<ReviewCandidateList> {
  const candidates = pendingCandidates(options.db);
  const enrolled = new Set(listFaceTemplates(options.db).map((row) => row.user_id));
  let rosterAvailable = true;
  try {
    const limit = options.limit ?? DEFAULT_LIMIT;
    for (const user of await rosterUsers(options)) {
      if (candidates.length >= limit) break;
      if (typeof user.userId !== 'string' || !user.userId) continue;
      if (enrolled.has(user.userId)) continue;
      if (rolesOf(user.roles).some((role) => options.staffRoles.includes(role))) continue;
      candidates.push({ userId: user.userId, hint: hintOf(user.userId, user.hint), state: 'unregistered', hasPhoto: false });
    }
  } catch {
    rosterAvailable = false;
  }
  return { candidates, rosterAvailable };
}

/**
 * 写真取得・審査の対象を施設の現在の候補へ限定する。
 * API を直接叩かれても、他施設または職員の userId をローカル正本の読み出しへ渡さない。
 */
export async function isReviewCandidate(userId: string, options: ReviewCandidateOptions): Promise<boolean> {
  const { candidates } = await listReviewCandidates(options);
  return candidates.some((candidate) => candidate.userId === userId);
}
