// 1:N 照合に載せる roster の構築。
//
// 載せてよいのは「state='active' かつ 同意が有効 (未撤回・365 日以内) かつ
// sidecar と同じ modelId」のテンプレートだけ:
//   - `pending` (写真由来) は職員が昇格するまで照合に使わない
//     (spec/feature/face-photo-seeded-enrollment.md §2)
//   - 同意の判定は Cernere 不通時の保険 (spec/plan/face-data-local-only.md §4)
//   - 開けない行 (鍵入れ替え・破損) は黙って除外する。生体情報をログに出さない。

import type Database from 'better-sqlite3';
import { getFaceConsentCopy, listFaceTemplates } from '../db.ts';
import { isFaceConsentUsable } from './consent-policy.ts';
import { openFaceTemplate, type LocalFaceKeys } from './local-key.ts';
import type { FaceRoster } from './matcher.ts';
import { contract } from '../contract-runtime.ts'; /* augur-inject:import:88d78595 */
import augurContract_eea9360d from '../../contracts/build-face-roster.contract.ts'; /* augur-inject:contract-predicate:37189d39 */

/**
 * 照合 roster を組む。
 *
 * @implements spec/feature/face-photo-seeded-enrollment.md#2-テンプレートの状態
 */
export function buildFaceRoster(
  db: Database.Database,
  keys: LocalFaceKeys,
  modelId: string,
  now: number = Date.now(),
): FaceRoster {
  const userIds: string[] = [];
  const embeddings: Float32Array[] = [];
  for (const row of listFaceTemplates(db, 'active')) {
    if (row.model_id !== modelId) continue;
    if (!isFaceConsentUsable(getFaceConsentCopy(db, row.user_id), row, now)) continue;
    try {
      const embedding = openFaceTemplate(keys, row.key_id, row.template_enc);
      userIds.push(row.user_id);
      embeddings.push(embedding);
    } catch {
      /* sealed rows that no key opens are excluded without exposing biometric material */
    }
  }
  return { userIds, embeddings };
}
// @ts-expect-error augur-inject
buildFaceRoster = contract(buildFaceRoster, { ...augurContract_eea9360d, contractId: 'C-4', mode: 'observe', sample: 1, where: 'server/face/template-roster.ts:16', rule: 'contract-wrap', id: 'eea9360d' }); /* augur-inject:contract-wrap:eea9360d */
