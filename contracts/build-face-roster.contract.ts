// C-4 buildFaceRoster(db, keys, modelId, now)
//
// 照合に載るのは state='active' かつ同意が有効 (未撤回・365 日以内) のテンプレートだけ
// (spec/feature/face-photo-seeded-enrollment.md §2 / spec/plan/face-data-local-only.md §4)。
// roster の userId は理由文字列に載せない (件数だけで判定する)。

import type Database from 'better-sqlite3';
import { getFaceConsentCopy, listFaceTemplates } from '../server/db.ts';
import { isFaceConsentUsable } from '../server/face/consent-policy.ts';
import type { LocalFaceKeys } from '../server/face/local-key.ts';
import type { FaceRoster } from '../server/face/matcher.ts';

export default {
  pre: (_db: Database.Database, _keys: LocalFaceKeys, modelId: string) =>
    (typeof modelId === 'string' && modelId.length > 0) || 'roster needs the sidecar model id',
  post: (roster: FaceRoster, db: Database.Database, _keys: LocalFaceKeys, modelId: string, now?: number) => {
    if (roster.userIds.length !== roster.embeddings.length) return 'roster ids and embeddings must pair up';
    const at = typeof now === 'number' ? now : Date.now();
    const matchable = new Set(
      listFaceTemplates(db)
        .filter((row) => row.state === 'active' && row.model_id === modelId)
        .filter((row) => isFaceConsentUsable(getFaceConsentCopy(db, row.user_id), row, at))
        .map((row) => row.user_id),
    );
    for (const userId of roster.userIds) {
      if (!matchable.has(userId)) return 'roster must only carry active, consented templates';
    }
    return true;
  },
};
