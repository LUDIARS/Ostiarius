// 施設内バックアップ (日次、直近 7 世代)。
//
// spec/plan/face-data-local-only.md §5:
//   - 顔データの正本がローカルになったので、施設内の暗号化バックアップを標準運用にする。
//   - 複製するのは **暗号化 DB だけ**。鍵ファイルは含めない (DB と鍵を同じ媒体に置かない)。
//   - 復元時は Cernere の失効指示 30 日分を先に適用してから照合を再開する
//     (revocation-sync.ts が `since` 未記録なら 30 日前から全量を取り直す)。
//
// 複製は better-sqlite3 のオンラインバックアップ API を使う。WAL で開いている DB を
// ファイル複製で持ち出すと壊れた断面を掴むため、ファイルシステム複製は使わない。

import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { FACE_KEY_FILE_NAME } from './local-key.ts';
import { contract } from '../contract-runtime.ts'; /* augur-inject:import:bdc000e5 */
import augurContract_2a42f331 from '../../contracts/run-face-backup.contract.ts'; /* augur-inject:contract-predicate:554de082 */

const BACKUP_PREFIX = 'ostiarius-';
const BACKUP_SUFFIX = '.db';
const DEFAULT_GENERATIONS = 7;
const DAILY_MS = 24 * 60 * 60 * 1000;

export interface FaceBackupOptions {
  /** 複製先 (OSTIARIUS_BACKUP_DIR)。施設内の USB / NAS を想定。 */
  backupDir: string;
  /** 鍵ファイルのあるディレクトリ (同一なら拒否する)。 */
  dataDir: string;
  /** 残す世代数 (既定 7)。 */
  generations?: number;
}

export interface FaceBackupResult {
  ok: boolean;
  /** 作成したバックアップのパス (失敗時は空)。 */
  path: string;
  /** ローテートで削除した世代数。 */
  rotated: number;
  reason?: 'backup_dir_equals_data_dir' | 'backup_failed';
}

function stamp(now: number): string {
  return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** 自分が作った世代だけを対象にする (媒体の他ファイルを消さない)。 */
function generationsOf(backupDir: string): string[] {
  return readdirSync(backupDir)
    .filter((entry) => entry.startsWith(BACKUP_PREFIX) && entry.endsWith(BACKUP_SUFFIX))
    .sort();
}

function rotate(backupDir: string, generations: number): number {
  const existing = generationsOf(backupDir);
  const excess = existing.slice(0, Math.max(0, existing.length - generations));
  for (const entry of excess) {
    try {
      unlinkSync(join(backupDir, entry));
    } catch {
      /* 媒体側の権限・取り外しは次回に持ち越す */
    }
  }
  return excess.length;
}

/**
 * 暗号化 DB を 1 世代複製し、古い世代を落とす。
 *
 * 鍵ファイル (`face-keys.json`) は複製しない — バックアップ媒体と鍵媒体を分けるのが
 * この運用の前提で、同じ媒体に両方あると「暗号化 DB を持ち出されたら終わり」になる。
 */
export async function runFaceBackup(
  db: Database.Database,
  options: FaceBackupOptions,
  now: number = Date.now(),
): Promise<FaceBackupResult> {
  const backupDir = resolve(options.backupDir);
  if (backupDir === resolve(options.dataDir)) {
    console.warn('[ostiarius] OSTIARIUS_BACKUP_DIR が OSTIARIUS_DATA と同じです — 鍵と DB を同じ媒体に置かないでください');
    return { ok: false, path: '', rotated: 0, reason: 'backup_dir_equals_data_dir' };
  }
  mkdirSync(backupDir, { recursive: true });
  if (readdirSync(backupDir).includes(FACE_KEY_FILE_NAME)) {
    console.warn('[ostiarius] バックアップ先に鍵ファイルがあります — 鍵は別媒体へ移してください');
  }
  const path = join(backupDir, `${BACKUP_PREFIX}${stamp(now)}${BACKUP_SUFFIX}`);
  try {
    await db.backup(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[ostiarius] バックアップに失敗: ${message}`);
    return { ok: false, path: '', rotated: 0, reason: 'backup_failed' };
  }
  const rotated = rotate(backupDir, options.generations ?? DEFAULT_GENERATIONS);
  const size = statSync(path).size;
  console.log(`[ostiarius] バックアップを作成: ${path} (${size} bytes, 古い世代 ${rotated} 件を削除)`);
  return { ok: true, path, rotated };
}
// @ts-expect-error augur-inject
runFaceBackup = contract(runFaceBackup, { ...augurContract_2a42f331, contractId: 'C-6', mode: 'observe', sample: 1, where: 'server/face/backup.ts:70', rule: 'contract-wrap', id: '2a42f331' }); /* augur-inject:contract-wrap:2a42f331 */

/** 起動時に 1 回 + 日次で複製する。timer は unref してプロセス終了を妨げない。 */
export function startFaceBackup(db: Database.Database, options: FaceBackupOptions): void {
  void runFaceBackup(db, options);
  const timer = setInterval(() => { void runFaceBackup(db, options); }, DAILY_MS);
  timer.unref?.();
}
