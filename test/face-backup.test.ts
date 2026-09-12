// 施設内バックアップの受け入れ条件。
//
// spec/plan/face-data-local-only.md §5:
//   - 複製するのは暗号化 DB だけ (鍵ファイルは含めない)
//   - 直近 7 世代でローテートする
//   - バックアップ先と鍵の置き場を同じにしない

import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { openDb } from '../server/db.ts';
import { FACE_KEY_FILE_NAME, loadLocalFaceKeys } from '../server/face/local-key.ts';
import { storeFacePhoto, storeFaceTemplate } from '../server/face/local-store.ts';
import { runFaceBackup } from '../server/face/backup.ts';

const MODEL_ID = 'insightface/glintr100@1';

function directory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function seededDb(dataDir: string) {
  const db = openDb(join(dataDir, 'ostiarius.db'));
  const keys = loadLocalFaceKeys(dataDir);
  const template = new Float32Array(512);
  template[2] = 1;
  storeFaceTemplate(db, keys, {
    userId: 'student-1', facilityId: 'facility-1', template, modelId: MODEL_ID,
    quality: 1, state: 'active', consentId: 'consent-1', enrolledBy: 'staff-1',
  });
  storeFacePhoto(db, keys, {
    userId: 'student-1', facilityId: 'facility-1', bytes: Buffer.from('raw-photo'), contentType: 'image/jpeg', consentId: 'consent-1',
  });
  return { db, keys, template };
}

describe('facility backup', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('copies the encrypted database without the key file', async () => {
    const dataDir = directory('ostiarius-data-');
    const backupDir = directory('ostiarius-backup-');
    const { db, template } = seededDb(dataDir);

    const result = await runFaceBackup(db, { backupDir, dataDir });
    expect(result.ok).toBe(true);
    const entries = readdirSync(backupDir);
    expect(entries).toHaveLength(1);
    expect(entries).not.toContain(FACE_KEY_FILE_NAME);

    // 複製は開ける DB で、中身は封緘されたまま (平文が媒体へ出ない)。
    const restored = new Database(result.path, { readonly: true });
    try {
      const row = restored.prepare('SELECT template_enc, photo_enc FROM face_templates JOIN face_photos USING (user_id)').get() as {
        template_enc: Buffer; photo_enc: Buffer;
      };
      expect(row.template_enc.includes(Buffer.from(template.buffer))).toBe(false);
      expect(row.photo_enc.includes(Buffer.from('raw-photo'))).toBe(false);
    } finally {
      restored.close();
    }
    expect(readFileSync(result.path).length).toBeGreaterThan(0);
  });

  it('keeps only the newest generations', async () => {
    const dataDir = directory('ostiarius-data-');
    const backupDir = directory('ostiarius-backup-');
    const { db } = seededDb(dataDir);

    const start = Date.UTC(2026, 8, 1);
    for (let day = 0; day < 4; day += 1) {
      await runFaceBackup(db, { backupDir, dataDir, generations: 2 }, start + day * 86_400_000);
    }
    const entries = readdirSync(backupDir).sort();
    expect(entries).toHaveLength(2);
    expect(entries[1]).toContain('20260904');
  });

  it('leaves files it did not create alone', async () => {
    const dataDir = directory('ostiarius-data-');
    const backupDir = directory('ostiarius-backup-');
    const { db } = seededDb(dataDir);
    writeFileSync(join(backupDir, 'README.txt'), 'facility media');

    await runFaceBackup(db, { backupDir, dataDir, generations: 1 }, Date.UTC(2026, 8, 1));
    await runFaceBackup(db, { backupDir, dataDir, generations: 1 }, Date.UTC(2026, 8, 2));
    expect(readdirSync(backupDir)).toContain('README.txt');
  });

  it('refuses to write backups next to the key file', async () => {
    const dataDir = directory('ostiarius-data-');
    const { db } = seededDb(dataDir);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await runFaceBackup(db, { backupDir: dataDir, dataDir });
    expect(result).toMatchObject({ ok: false, reason: 'backup_dir_equals_data_dir' });
    expect(warn).toHaveBeenCalled();
  });
});
