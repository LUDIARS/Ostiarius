// C-2 storeFaceTemplate(db, keys, input)
//
// テンプレートは封緘後の blob と key_id としてだけ永続層へ渡る
// (spec/plan/biometric-data-policy.md §1 / §5)。平文が DB に落ちていないことを、
// 書き込んだ行を読み直して確かめる。理由文字列に埋め込み値を載せない。

import type Database from 'better-sqlite3';
import { getFaceTemplate } from '../server/db.ts';
import type { LocalFaceKeys } from '../server/face/local-key.ts';
import type { StoreTemplateInput } from '../server/face/local-store.ts';

const TEMPLATE_DIMENSION = 512;

export default {
  pre: (_db: Database.Database, _keys: LocalFaceKeys, input: StoreTemplateInput) => {
    if (input.template.length !== TEMPLATE_DIMENSION) return 'template must be a 512d embedding';
    if (!input.userId) return 'template must belong to a user';
    if (input.state !== 'pending' && input.state !== 'active') return 'stored state must be pending or active';
    return true;
  },
  post: (_version: number, db: Database.Database, _keys: LocalFaceKeys, input: StoreTemplateInput) => {
    const row = getFaceTemplate(db, input.userId);
    if (!row) return 'stored template must be readable back';
    if (!row.key_id) return 'stored template must record the sealing key id';
    // 平文 Float32 をそのまま入れていないこと (封緘は nonce + ciphertext + tag で長さが増える)。
    if (row.template_enc.length <= TEMPLATE_DIMENSION * 4) return 'stored template must be sealed, not raw';
    return true;
  },
};
