// 顔データの封緘鍵はホスト内で生成し、平文はディスクへ落ちない、という受け入れ条件。
//
// spec/plan/face-data-local-only.md §3 / spec/plan/biometric-data-policy.md §5:
//   - テンプレート鍵と写真鍵は別鍵 (鍵 ID を分ける)
//   - 鍵ファイルは OSTIARIUS_DATA 配下に 0600 で置く (env / Infisical から配らない)
//   - 一度生成した鍵は再起動で変わらない (変わると全登録が開けなくなる)

import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FACE_KEY_FILE_NAME,
  loadLocalFaceKeys,
  openFaceTemplate,
  openFaceValue,
  sealFaceTemplate,
  sealFaceValue,
} from '../server/face/local-key.ts';

function dataDir(): string {
  return mkdtempSync(join(tmpdir(), 'ostiarius-key-'));
}

describe('local face keys', () => {
  it('generates separate 32-byte template and photo keys inside the data directory', () => {
    const directory = dataDir();
    const keys = loadLocalFaceKeys(directory);
    expect(keys.template.key).toHaveLength(32);
    expect(keys.photo.key).toHaveLength(32);
    expect(keys.template.keyId).not.toBe(keys.photo.keyId);
    expect(keys.template.key.equals(keys.photo.key)).toBe(false);
    expect(existsSync(join(directory, FACE_KEY_FILE_NAME))).toBe(true);
  });

  it('keeps the same keys across restarts', () => {
    const directory = dataDir();
    const first = loadLocalFaceKeys(directory);
    const second = loadLocalFaceKeys(directory);
    expect(second.template.keyId).toBe(first.template.keyId);
    expect(second.photo.key.equals(first.photo.key)).toBe(true);
  });

  it('restricts the key file to the owner on POSIX hosts', () => {
    const directory = dataDir();
    loadLocalFaceKeys(directory);
    const mode = statSync(join(directory, FACE_KEY_FILE_NAME)).mode & 0o777;
    // Windows は POSIX の permission bits を持たない (常に 0o666) ので ACL / ディスク暗号化に任せる。
    if (process.platform === 'win32') expect(mode).toBeGreaterThan(0);
    else expect(mode).toBe(0o600);
  });

  it('round-trips a 512d template and rejects a tampered blob', () => {
    const keys = loadLocalFaceKeys(dataDir());
    const template = new Float32Array(512);
    template[11] = 0.5;
    const { keyId, sealed } = sealFaceTemplate(keys, template);
    expect(openFaceTemplate(keys, keyId, sealed)[11]).toBeCloseTo(0.5);
    const tampered = Buffer.from(sealed);
    tampered.writeUInt8(tampered.readUInt8(tampered.length - 1) ^ 0xff, tampered.length - 1);
    expect(() => openFaceTemplate(keys, keyId, tampered)).toThrow();
  });

  it('does not open a template with the photo key (and the other way round)', () => {
    const keys = loadLocalFaceKeys(dataDir());
    const template = new Float32Array(512);
    template[0] = 1;
    const { sealed } = sealFaceTemplate(keys, template);
    expect(() => openFaceValue(keys, keys.photo.keyId, sealed)).toThrow();
    const photo = sealFaceValue(keys.photo, Buffer.from('photo-bytes'));
    expect(() => openFaceValue(keys, keys.template.keyId, photo)).toThrow();
  });

  it('never writes template or photo plaintext into the key file', () => {
    const directory = dataDir();
    const keys = loadLocalFaceKeys(directory);
    const template = new Float32Array(512);
    template.fill(0.125);
    sealFaceTemplate(keys, template);
    sealFaceValue(keys.photo, Buffer.from('raw-photo-bytes'));
    const onDisk = readFileSync(join(directory, FACE_KEY_FILE_NAME));
    expect(onDisk.includes(Buffer.from(template.buffer))).toBe(false);
    expect(onDisk.includes(Buffer.from('raw-photo-bytes'))).toBe(false);
  });

  it('refuses to silently regenerate keys when the key file is unreadable', () => {
    const directory = dataDir();
    const keys = loadLocalFaceKeys(directory);
    writeFileSync(join(directory, FACE_KEY_FILE_NAME), 'not json');
    // 生成し直すと既存登録が全部開けなくなるので、黙って作り直さない。
    expect(() => loadLocalFaceKeys(directory)).toThrow();
    expect(keys.template.keyId).toBeTruthy();
  });
});
