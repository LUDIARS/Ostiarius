// C-6 runFaceBackup(db, options)
//
// 施設内バックアップは「暗号化 DB を複製し、直近 7 世代でローテートする。鍵ファイルは
// 含めない」(spec/plan/face-data-local-only.md §5)。世代数と鍵ファイル非混入を確かめる。
// パスは理由文字列に載せない。

import { existsSync, readdirSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { FaceBackupOptions, FaceBackupResult } from '../server/face/backup.ts';
import { FACE_KEY_FILE_NAME } from '../server/face/local-key.ts';

export default {
  pre: (_db: Database.Database, options: FaceBackupOptions) => {
    if (!options.backupDir) return 'backup directory is required';
    if (options.generations !== undefined && options.generations < 1) return 'at least one generation must be kept';
    return true;
  },
  post: (result: FaceBackupResult, _db: Database.Database, options: FaceBackupOptions) => {
    // 失敗 (媒体未接続など) は運用ログの担当で、契約違反にはしない。
    if (!result.ok || !result.path) return true;
    if (!existsSync(result.path)) return 'backup file must exist after a successful run';
    const entries = readdirSync(options.backupDir);
    if (entries.includes(FACE_KEY_FILE_NAME)) return 'backup directory must not receive the key file';
    const generations = options.generations ?? 7;
    const copies = entries.filter((entry) => entry.endsWith('.db'));
    if (copies.length > generations) return 'backup must keep at most the configured generations';
    return true;
  },
};
