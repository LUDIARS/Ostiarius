// C-5 storeFacePhoto(db, keys, input)
//
// 顔写真はテンプレートと別鍵で封緘して保存する
// (spec/plan/biometric-data-policy.md §1.1)。写真バイト・content-type 以外は
// 理由文字列に載せない。

import type Database from 'better-sqlite3';
import { getFacePhoto } from '../server/db.ts';
import type { LocalFaceKeys } from '../server/face/local-key.ts';
import type { StorePhotoInput } from '../server/face/local-store.ts';

export default {
  pre: (_db: Database.Database, _keys: LocalFaceKeys, input: StorePhotoInput) => {
    if (!input.userId) return 'photo must belong to a user';
    if (!input.bytes.length) return 'photo must carry bytes';
    return true;
  },
  post: (_result: unknown, db: Database.Database, keys: LocalFaceKeys, input: StorePhotoInput) => {
    const row = getFacePhoto(db, input.userId);
    if (!row) return 'stored photo must be readable back';
    if (row.key_id !== keys.photo.keyId) return 'photo must be sealed with the photo key';
    if (row.key_id === keys.template.keyId) return 'photo key must differ from the template key';
    if (row.photo_enc.equals(input.bytes)) return 'stored photo must be sealed, not raw';
    return true;
  },
};
