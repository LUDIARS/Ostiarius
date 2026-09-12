// Cernere からの **失効指示と同意の pull** (旧: 顔テンプレート export の取得)。
//
// spec/interface/cernere-face-template.md §A / spec/plan/face-data-local-only.md §4:
//   - GET /api/identity/face-revocations?facilityId=&since=  (scope face-revocation:read)
//     撤回・所属離脱・卒業・アカウント削除・365 日再同意なし・職員無効化のたびに 1 行。
//     生体情報は含まない。受けたら該当 user のテンプレート・写真・同意写しを物理削除する。
//   - GET /api/identity/face-consents?facilityId=            (scope face-consent:read)
//     施設在籍者分の同意の全量。照合可否 (未撤回・365 日以内) を Cernere 不通時にも
//     自前判定するための写し。
//
// どちらも**まだ Cernere 側に実装が無い可能性がある**。404 は warn に留め、既存動作
// (ローカル正本での照合) を壊さない。通信断も同じ — 前回の状態で運用を続ける。
//
// `since` は前回成功位置。未記録 (初回・バックアップ復元直後) なら 30 日前から全量を
// 取り直す (削除済みの人物を復元で蘇らせないため)。

import type Database from 'better-sqlite3';
import { getSyncState, setSyncState } from '../db.ts';
import type { ServiceTokenProvider } from '../cernere-service-token.ts';
import { deleteFaceRegistration, storeFaceConsentCopy } from './local-store.ts';
import { contract } from '../contract-runtime.ts'; /* augur-inject:import:5d4a556e */
import augurContract_679fab4e from '../../contracts/apply-face-revocations.contract.ts'; /* augur-inject:contract-predicate:34fa2187 */

/** 失効指示 1 件 (生体情報を含まない)。 */
export interface FaceRevocation {
  userId: string;
  facilityId: string;
  reason: string;
  at: number;
}

/** 同意記録の写し 1 件。 */
export interface FaceConsentRecord {
  userId: string;
  consentId: string;
  policyVersion: string;
  at: number;
  revokedAt: number | null;
}

export interface FaceSyncOptions {
  db: Database.Database;
  baseUrl: string;
  serviceToken: ServiceTokenProvider;
  facilityId: string;
  /** 初回・復元直後に遡る幅 (既定 30 日 = Cernere の失効指示保持期間)。 */
  lookbackMs?: number;
}

export interface FacePullResult {
  ok: boolean;
  /** Cernere にその API がまだ無い (404)。既存動作は変えない。 */
  unsupported: boolean;
  applied: number;
}

const SINCE_STATE_KEY = 'face_revocations_since';
const DEFAULT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
/** 取得中に書かれた行を落とさないための巻き戻し。 */
const SINCE_OVERLAP_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toRevocation(value: unknown): FaceRevocation | null {
  if (!isRecord(value) || typeof value.userId !== 'string' || !value.userId) return null;
  return {
    userId: value.userId,
    facilityId: typeof value.facilityId === 'string' ? value.facilityId : '',
    reason: typeof value.reason === 'string' ? value.reason : 'unspecified',
    at: typeof value.at === 'number' ? value.at : Date.now(),
  };
}

function toConsent(value: unknown): FaceConsentRecord | null {
  if (!isRecord(value) || typeof value.userId !== 'string' || !value.userId) return null;
  if (typeof value.consentId !== 'string' || !value.consentId) return null;
  return {
    userId: value.userId,
    consentId: value.consentId,
    policyVersion: typeof value.policyVersion === 'string' ? value.policyVersion : 'unknown',
    at: typeof value.at === 'number' ? value.at : Date.now(),
    revokedAt: typeof value.revokedAt === 'number' ? value.revokedAt : null,
  };
}

async function getJson(url: URL, serviceToken: ServiceTokenProvider): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${await serviceToken()}` } });
  if (!response.ok) return { status: response.status, body: null };
  return { status: response.status, body: await response.json() };
}

/** 失効指示の開始位置。未記録なら 30 日前 (バックアップ復元時の全量適用)。 */
export function revocationSince(db: Database.Database, lookbackMs = DEFAULT_LOOKBACK_MS, now = Date.now()): number {
  const stored = Number(getSyncState(db, SINCE_STATE_KEY) ?? '');
  return Number.isFinite(stored) && stored > 0 ? stored : now - lookbackMs;
}

/**
 * 失効指示を適用する。1 件につきテンプレート・写真・同意の写しを **同時に** 物理削除する
 * (spec/plan/biometric-data-policy.md §3)。戻りは実際に何か消えた件数。
 */
export function applyFaceRevocations(db: Database.Database, revocations: readonly FaceRevocation[]): number {
  let applied = 0;
  for (const revocation of revocations) {
    if (!revocation.userId) continue;
    const removed = deleteFaceRegistration(db, revocation.userId);
    if (removed.templates || removed.photos || removed.consents) applied += 1;
  }
  return applied;
}
// @ts-expect-error augur-inject
applyFaceRevocations = contract(applyFaceRevocations, { ...augurContract_679fab4e, contractId: 'C-3', mode: 'observe', sample: 1, where: 'server/face/revocation-sync.ts:102', rule: 'contract-wrap', id: '679fab4e' }); /* augur-inject:contract-wrap:679fab4e */

/** 失効指示を pull して適用する。 */
export async function pullFaceRevocations(options: FaceSyncOptions, now = Date.now()): Promise<FacePullResult> {
  const since = revocationSince(options.db, options.lookbackMs, now);
  const url = new URL('/api/identity/face-revocations', options.baseUrl);
  url.searchParams.set('facilityId', options.facilityId);
  url.searchParams.set('since', String(since));
  try {
    const { status, body } = await getJson(url, options.serviceToken);
    if (status === 404) {
      console.warn('[ostiarius] Cernere に face-revocations がまだありません — ローカル正本のまま継続します');
      return { ok: false, unsupported: true, applied: 0 };
    }
    if (!isRecord(body)) throw new Error(`face revocations failed: HTTP ${status}`);
    const revocations = Array.isArray(body.revocations)
      ? body.revocations.map(toRevocation).filter((item): item is FaceRevocation => item !== null)
      : [];
    const applied = applyFaceRevocations(options.db, revocations);
    setSyncState(options.db, SINCE_STATE_KEY, String(now - SINCE_OVERLAP_MS));
    if (applied) console.log(`[ostiarius] 失効指示を適用しました: ${applied} 件の顔登録を削除`);
    return { ok: true, unsupported: false, applied };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[ostiarius] 失効指示の取得に失敗: ${message} — 次回の同期で再試行します`);
    return { ok: false, unsupported: false, applied: 0 };
  }
}

/**
 * 同意の全量を pull して写しを更新する。
 * 撤回済み (`revokedAt`) の同意はその場で登録ごと削除する (失効指示の取りこぼし対策)。
 */
export async function pullFaceConsents(options: FaceSyncOptions): Promise<FacePullResult> {
  const url = new URL('/api/identity/face-consents', options.baseUrl);
  url.searchParams.set('facilityId', options.facilityId);
  try {
    const { status, body } = await getJson(url, options.serviceToken);
    if (status === 404) {
      console.warn('[ostiarius] Cernere に face-consents がまだありません — 同意の写しは enroll 時の記録で判定します');
      return { ok: false, unsupported: true, applied: 0 };
    }
    if (!isRecord(body)) throw new Error(`face consents failed: HTTP ${status}`);
    const consents = Array.isArray(body.consents)
      ? body.consents.map(toConsent).filter((item): item is FaceConsentRecord => item !== null)
      : [];
    let applied = 0;
    for (const consent of consents) {
      if (consent.revokedAt) {
        deleteFaceRegistration(options.db, consent.userId);
        applied += 1;
        continue;
      }
      storeFaceConsentCopy(options.db, consent);
      applied += 1;
    }
    return { ok: true, unsupported: false, applied };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[ostiarius] 同意の取得に失敗: ${message} — 前回の写しで継続します`);
    return { ok: false, unsupported: false, applied: 0 };
  }
}

export interface FaceSyncResult {
  revocations: FacePullResult;
  consents: FacePullResult;
}

/** 定期同期 (15 分) と職員の即時 sync が呼ぶ入口。 */
export async function syncFaceData(options: FaceSyncOptions): Promise<FaceSyncResult> {
  return {
    revocations: await pullFaceRevocations(options),
    consents: await pullFaceConsents(options),
  };
}
