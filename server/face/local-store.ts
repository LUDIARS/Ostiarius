// 顔データ (テンプレート・写真・同意の写し) の **ローカル正本** への読み書き。
//
// spec/plan/face-data-local-only.md §2: 正本は Ostiarius (施設単位、暗号化 SQLite)。
// Cernere へは一切書き戻さない。
//
// このモジュールの役割は「平文 ⇄ 封緘済み blob」の境界をここ 1 箇所に閉じること:
//   - 書き込み: 平文を受け取り、face/local-key.ts で封緘してから db.ts へ渡す
//   - 読み出し: db.ts の blob を `key_id` で開いて平文を返す
//   - 削除    : テンプレート・写真・同意の写しを常に同時に消す (db.purgeFaceSubject)
//
// 平文はここから外 (ディスク・ログ・Cernere) へ出さない。

import type Database from 'better-sqlite3';
import {
  getFacePhoto,
  getFaceTemplate,
  purgeFaceSubject,
  setFaceTemplateState,
  upsertFaceConsentCopy,
  upsertFacePhoto,
  upsertFaceTemplate,
  type FaceSubjectRowCounts,
  type FaceTemplateRow,
} from '../db.ts';
import { openFaceTemplate, openFaceValue, sealFaceTemplate, sealFaceValue, type LocalFaceKeys } from './local-key.ts';
import { contract } from '../contract-runtime.ts'; /* augur-inject:import:b15a6af5 */
import augurContract_988a4b17 from '../../contracts/store-face-template.contract.ts'; /* augur-inject:contract-predicate:8ebfd579 */
import augurContract_12addf96 from '../../contracts/store-face-photo.contract.ts'; /* augur-inject:contract-predicate:2fa27735 */

export interface StoreTemplateInput {
  userId: string;
  facilityId: string;
  template: Float32Array;
  modelId: string;
  quality: number;
  /** 写真由来は `pending`、職員立会い enroll と昇格後は `active`。 */
  state: 'pending' | 'active';
  consentId: string | null;
  enrolledBy: string | null;
  version?: number;
  enrolledAt?: number;
}

export interface StorePhotoInput {
  userId: string;
  facilityId: string;
  bytes: Buffer;
  contentType: string;
  consentId: string | null;
  createdAt?: number;
}

export interface StoredFacePhoto {
  bytes: Buffer;
  contentType: string;
  createdAt: number;
}

/** テンプレートを封緘して保存し、付与した version を返す。 */
export function storeFaceTemplate(db: Database.Database, keys: LocalFaceKeys, input: StoreTemplateInput): number {
  const { keyId, sealed } = sealFaceTemplate(keys, input.template);
  const version = input.version ?? Date.now();
  upsertFaceTemplate(db, {
    userId: input.userId,
    facilityId: input.facilityId,
    templateEnc: sealed,
    keyId,
    modelId: input.modelId,
    quality: input.quality,
    version,
    state: input.state,
    consentId: input.consentId,
    enrolledBy: input.enrolledBy,
    enrolledAt: input.enrolledAt ?? Date.now(),
  });
  return version;
}
// @ts-expect-error augur-inject
storeFaceTemplate = contract(storeFaceTemplate, { ...augurContract_988a4b17, contractId: 'C-2', mode: 'observe', sample: 1, where: 'server/face/local-store.ts:57', rule: 'contract-wrap', id: '988a4b17' }); /* augur-inject:contract-wrap:988a4b17 */

/** 封緘済みテンプレートを開いて返す。開けない行は null (照合から外す)。 */
export function readFaceTemplate(
  db: Database.Database,
  keys: LocalFaceKeys,
  userId: string,
): { row: FaceTemplateRow; embedding: Float32Array } | null {
  const row = getFaceTemplate(db, userId);
  if (!row) return null;
  try {
    return { row, embedding: openFaceTemplate(keys, row.key_id, row.template_enc) };
  } catch {
    // 鍵が入れ替わった / 行が壊れた場合。生体情報を露出させずに除外する。
    return null;
  }
}

/** 写真由来 pending を職員の承認で active にする。 */
export function activateFaceTemplate(db: Database.Database, userId: string): boolean {
  return setFaceTemplateState(db, userId, 'active');
}

/** プロフィール顔写真 1 枚を写真鍵で封緘して保存する。 */
export function storeFacePhoto(db: Database.Database, keys: LocalFaceKeys, input: StorePhotoInput): void {
  upsertFacePhoto(db, {
    userId: input.userId,
    facilityId: input.facilityId,
    photoEnc: sealFaceValue(keys.photo, input.bytes),
    keyId: keys.photo.keyId,
    contentType: input.contentType,
    consentId: input.consentId,
    createdAt: input.createdAt ?? Date.now(),
  });
}
// @ts-expect-error augur-inject
storeFacePhoto = contract(storeFacePhoto, { ...augurContract_12addf96, contractId: 'C-5', mode: 'observe', sample: 1, where: 'server/face/local-store.ts:98', rule: 'contract-wrap', id: '12addf96' }); /* augur-inject:contract-wrap:12addf96 */

/** 封緘済み写真を開いて返す。開けない行は null。 */
export function readFacePhoto(db: Database.Database, keys: LocalFaceKeys, userId: string): StoredFacePhoto | null {
  const row = getFacePhoto(db, userId);
  if (!row) return null;
  try {
    return {
      bytes: openFaceValue(keys, row.key_id, row.photo_enc),
      contentType: row.content_type,
      createdAt: row.created_at,
    };
  } catch {
    return null;
  }
}

/** Cernere 正本の同意記録の写しを保存する (照合可否の自前判定用)。 */
export function storeFaceConsentCopy(
  db: Database.Database,
  input: { userId: string; consentId: string; policyVersion: string; at: number; revokedAt?: number | null },
): void {
  upsertFaceConsentCopy(db, {
    userId: input.userId,
    consentId: input.consentId,
    policyVersion: input.policyVersion,
    at: input.at,
    revokedAt: input.revokedAt ?? null,
  });
}

/**
 * 1 人分の顔登録 (テンプレート・写真・同意の写し) を物理削除する。
 * 削除経路はすべてここを通す (片方だけ残る状態を作らない)。
 */
export function deleteFaceRegistration(db: Database.Database, userId: string): FaceSubjectRowCounts {
  return purgeFaceSubject(db, userId);
}
