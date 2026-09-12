// 顔テンプレート鍵・顔写真鍵の **ホスト内生成と保管**。
//
// spec/plan/face-data-local-only.md §3 (「絶対ローカル」を鍵にも適用する):
//   - 鍵は kiosk ホストで生成し、ホスト外へ出さない。Infisical に置かない
//     (`OSTIARIUS_TEMPLATE_KEY` の env / Infisical 配布は廃止)。
//   - 保存先は優先順に TPM 封緘 → OS 資格情報ストア → `OSTIARIUS_DATA` 配下の 0600
//     鍵ファイル。TPM / 資格情報ストアは §8 の未決事項なので、ここでは **鍵ファイルだけ**
//     を実装する。ホストのディスク暗号化 (BitLocker / LUKS) が前提条件になる (README)。
//   - テンプレートと写真は **別鍵** (鍵 ID を分ける)。写真はテンプレートより復元容易な
//     個人情報なので、片方の鍵が漏れてももう片方が開かないようにする。
//   - 鍵の喪失 = 全登録の喪失と割り切る (再登録で復旧)。エスクローは作らない。
//
// 鍵ファイルは過去鍵も配列で持つ。鍵を入れ替えても、まだその鍵で封緘されている行を
// 読めるようにするため (行の `key_id` から引く)。
//
// このモジュールは平文の埋め込み・写真バイトをメモリ上でのみ扱う。ディスクへ書くのは
// 鍵ファイルだけで、封緘済み blob は永続層 (db.ts) の責務。

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { contract } from '../contract-runtime.ts'; /* augur-inject:import:4d17d2a6 */
import augurContract_685fc38e from '../../contracts/load-local-face-keys.contract.ts'; /* augur-inject:contract-predicate:98c922ea */

/** 鍵ファイル名。バックアップ媒体へ混ぜないことの検査にも使う (backup.ts)。 */
export const FACE_KEY_FILE_NAME = 'face-keys.json';

const TEMPLATE_DIMENSION = 512;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export type FaceKeyPurpose = 'template' | 'photo';

export interface FaceKey {
  keyId: string;
  key: Buffer;
  purpose: FaceKeyPurpose;
}

export interface LocalFaceKeys {
  /** 現行のテンプレート鍵 (書き込みに使う)。 */
  template: FaceKey;
  /** 現行の写真鍵 (書き込みに使う)。 */
  photo: FaceKey;
  /** 過去鍵を含む鍵 ID 解決 (読み出しに使う)。 */
  byId(keyId: string): FaceKey | null;
}

interface StoredKey {
  keyId: string;
  purpose: FaceKeyPurpose;
  key: string;
  createdAt: number;
}

interface KeyFile {
  version: 1;
  keys: StoredKey[];
}

function isStoredKey(value: unknown): value is StoredKey {
  const candidate = value as StoredKey | null;
  return typeof candidate?.keyId === 'string'
    && typeof candidate.key === 'string'
    && (candidate.purpose === 'template' || candidate.purpose === 'photo');
}

function readKeyFile(path: string): KeyFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // 生成し直すと既存の登録が全部開けなくなる。壊れた鍵ファイルは運用者に直させる。
    throw new Error(`[ostiarius] 顔鍵ファイルを読めません: ${path} (復旧できない場合は全員の再登録が必要です)`);
  }
  const keys = (parsed as KeyFile | null)?.keys;
  return { version: 1, keys: Array.isArray(keys) ? keys.filter(isStoredKey) : [] };
}

function writeKeyFile(path: string, file: KeyFile): void {
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600); // Windows では実質 no-op だが best-effort
  } catch {
    /* 権限を締められないホストでもディスク暗号化が前提 (README) */
  }
}

function generateKey(purpose: FaceKeyPurpose): StoredKey {
  return {
    keyId: `${purpose === 'template' ? 'tpl' : 'pho'}-${randomBytes(8).toString('hex')}`,
    purpose,
    key: randomBytes(KEY_BYTES).toString('base64'),
    createdAt: Date.now(),
  };
}

function toFaceKey(stored: StoredKey): FaceKey {
  const key = Buffer.from(stored.key, 'base64');
  if (key.length !== KEY_BYTES) throw new Error(`[ostiarius] 顔鍵 ${stored.keyId} が 32 byte ではありません`);
  return { keyId: stored.keyId, key, purpose: stored.purpose };
}

/** 用途ごとの現行鍵 = その用途で最後に作られた鍵。 */
function currentOf(keys: readonly StoredKey[], purpose: FaceKeyPurpose): StoredKey | null {
  const candidates = keys.filter((key) => key.purpose === purpose);
  return candidates.reduce<StoredKey | null>(
    (latest, key) => (!latest || key.createdAt > latest.createdAt ? key : latest),
    null,
  );
}

/**
 * `OSTIARIUS_DATA` 配下の 0600 鍵ファイルからテンプレート鍵・写真鍵を読む。
 * 無ければその場で生成して保存する (kiosk ホスト内生成)。
 */
export function loadLocalFaceKeys(dataDir: string): LocalFaceKeys {
  const path = join(dataDir, FACE_KEY_FILE_NAME);
  mkdirSync(dataDir, { recursive: true });
  const file = existsSync(path) ? readKeyFile(path) : { version: 1 as const, keys: [] };
  const generated: FaceKeyPurpose[] = [];
  for (const purpose of ['template', 'photo'] as const) {
    if (currentOf(file.keys, purpose)) continue;
    file.keys.push(generateKey(purpose));
    generated.push(purpose);
  }
  if (generated.length) {
    writeKeyFile(path, file);
    console.log(`[ostiarius] 顔データの封緘鍵をホスト内で生成しました (${generated.join(', ')}) — ホスト外へ配布しません`);
  }

  const byId = new Map(file.keys.map((stored) => [stored.keyId, toFaceKey(stored)]));
  const template = currentOf(file.keys, 'template');
  const photo = currentOf(file.keys, 'photo');
  if (!template || !photo) throw new Error('[ostiarius] 顔鍵の解決に失敗しました');
  return {
    template: toFaceKey(template),
    photo: toFaceKey(photo),
    byId: (keyId) => byId.get(keyId) ?? null,
  };
}
// @ts-expect-error augur-inject
loadLocalFaceKeys = contract(loadLocalFaceKeys, { ...augurContract_685fc38e, contractId: 'C-1', mode: 'observe', sample: 1, where: 'server/face/local-key.ts:116', rule: 'contract-wrap', id: '685fc38e' }); /* augur-inject:contract-wrap:685fc38e */

/** AES-256-GCM で封緘する。戻りは `nonce | ciphertext | tag`。 */
export function sealFaceValue(key: FaceKey, plain: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key.key, nonce);
  return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

/** 封緘を解く。鍵 ID が解決できない / 改ざんされている場合は throw。 */
export function openFaceValue(keys: LocalFaceKeys, keyId: string, sealed: Buffer): Buffer {
  const key = keys.byId(keyId);
  if (!key) throw new Error('sealed value references an unknown key id');
  if (sealed.length < NONCE_BYTES + TAG_BYTES) throw new Error('sealed value is truncated');
  const decipher = createDecipheriv('aes-256-gcm', key.key, sealed.subarray(0, NONCE_BYTES));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  return Buffer.concat([
    decipher.update(sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES)),
    decipher.final(),
  ]);
}

/** 512d 埋め込みをテンプレート鍵で封緘する。 */
export function sealFaceTemplate(keys: LocalFaceKeys, template: Float32Array): { keyId: string; sealed: Buffer } {
  if (template.length !== TEMPLATE_DIMENSION) throw new Error('face template dimension mismatch');
  const plain = Buffer.from(template.buffer, template.byteOffset, template.byteLength);
  return { keyId: keys.template.keyId, sealed: sealFaceValue(keys.template, plain) };
}

/** 封緘済みテンプレートを 512d 埋め込みへ戻す。 */
export function openFaceTemplate(keys: LocalFaceKeys, keyId: string, sealed: Buffer): Float32Array {
  const plain = openFaceValue(keys, keyId, sealed);
  if (plain.length !== TEMPLATE_DIMENSION * 4) throw new Error('face template dimension mismatch');
  return new Float32Array(plain.buffer, plain.byteOffset, TEMPLATE_DIMENSION).slice();
}
