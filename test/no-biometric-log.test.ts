// 生体情報がログ・ディスクへ漏れない境界の文字列検査。
//
// spec/plan/biometric-data-policy.md §5:
//   画像・テンプレート・氏名をログに出さない。写真バイト列・data URL・base64 画像も
//   同じ検査の対象にする。
//
// ディスク書き込みの例外は 2 つだけで、どちらも **封緘済みのものしか書かない**:
//   - face/local-key.ts : 鍵ファイル (0600)。中身に平文が入らないことは
//     test/face-local-key.test.ts が実際に書いて確かめる。
//   - face/backup.ts    : 暗号化 DB のオンラインバックアップ。
//     鍵ファイルを含めないことは test/face-backup.test.ts が確かめる。

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 鍵ファイルと暗号化 DB のバックアップだけがディスクへ書く。 */
const DISK_WRITE_ALLOWED = new Set(['local-key.ts', 'backup.ts']);

const LOGGED_BIOMETRIC = /console\.(?:log|warn|error)\([^)]*(?:frame|embedding|template|image|photo|name|base64|dataUrl|data:image)/i;
const DISK_WRITE = /writeFile|appendFile|createWriteStream/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

function read(directory: string): Array<{ name: string; source: string }> {
  return sourceFiles(join(process.cwd(), 'server', directory))
    .map((path) => ({ name: path.split(/[\\/]/).at(-1) ?? path, source: readFileSync(path, 'utf8') }));
}

/**
 * 行頭コメントとブロックコメントを落とす。
 * 撤去したはずの API を「なぜ撤去したか」の説明で書けるようにするため、検査の対象は
 * 実際のコードだけにする (行末の `//` は URL リテラルを壊すので落とさない)。
 */
function code(files: Array<{ source: string }>): string {
  return files
    .map((file) => file.source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))
    .join('\n');
}

describe('biometric privacy boundary', () => {
  it('does not log raw frames, embeddings, photos, or full-name fields', () => {
    const source = code([...read('face'), ...read('routes')]);
    expect(source).not.toMatch(LOGGED_BIOMETRIC);
  });

  it('only writes to disk from the key store and the encrypted backup', () => {
    for (const file of read('face')) {
      if (DISK_WRITE_ALLOWED.has(file.name)) continue;
      expect(file.source, `${file.name} must not write to disk`).not.toMatch(DISK_WRITE);
    }
    for (const file of read('routes')) {
      expect(file.source, `${file.name} must not write to disk`).not.toMatch(DISK_WRITE);
    }
  });

  it('keeps template and photo plaintext out of the persistence layer', () => {
    const db = readFileSync(join(process.cwd(), 'server', 'db.ts'), 'utf8');
    // 封緘は face/local-key.ts の担当。db.ts は blob と key_id しか扱わない。
    expect(db).not.toMatch(/createCipheriv|createDecipheriv/);
    expect(db).not.toMatch(/Float32Array/);
  });

  it('has no Cernere face-template or face-photo calls left', () => {
    const source = code([...read('face'), ...read('routes')]);
    expect(source).not.toMatch(/api\/identity\/face-template/);
    expect(source).not.toMatch(/api\/identity\/face-photo/);
  });

  it('no longer takes the template key from configuration', () => {
    // 鍵はホスト内生成 (spec/plan/face-data-local-only.md §3)。設定・カタログから消えていること
    // (移行の経緯を説明するコメントは対象外 — env として読まないことが条件)。
    for (const path of ['server/config.ts', 'env-cli.config.ts', 'excubitor.catalog.yaml']) {
      expect(readFileSync(join(process.cwd(), path), 'utf8'), path).not.toMatch(/OSTIARIUS_TEMPLATE_KEY/);
    }
  });
});
