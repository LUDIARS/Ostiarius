// C-3 applyFaceRevocations(db, revocations)
//
// 失効指示は「テンプレート・写真・同意の写しを同時に物理削除する」
// (spec/plan/biometric-data-policy.md §3: 片方が残る状態を作らない)。
// 適用後に残骸が無いことを確かめる。userId は理由文字列に載せない。

import type Database from 'better-sqlite3';
import { countFaceSubjectRows } from '../server/db.ts';
import type { FaceRevocation } from '../server/face/revocation-sync.ts';

export default {
  pre: (_db: Database.Database, revocations: readonly FaceRevocation[]) =>
    Array.isArray(revocations) || 'revocations must be a list',
  post: (_applied: number, db: Database.Database, revocations: readonly FaceRevocation[]) => {
    for (const revocation of revocations) {
      if (!revocation.userId) continue;
      const remaining = countFaceSubjectRows(db, revocation.userId);
      if (remaining.templates > 0) return 'revoked user must keep no template';
      if (remaining.photos > 0) return 'revoked user must keep no photo';
      if (remaining.consents > 0) return 'revoked user must keep no consent copy';
    }
    return true;
  },
};
