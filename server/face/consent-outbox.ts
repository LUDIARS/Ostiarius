// 同意撤回 (`POST /api/identity/face-consent/revoke`) の再送キュー。
//
// spec/interface/cernere-face-template.md §A: kiosk 上で生徒本人が (職員立会いで)
// 登録を削除したとき、ローカルは先に物理削除し、Cernere への撤回はこの outbox で再送する。
// **削除を Cernere の可用性に依存させない**のが目的 (消したのに残っている状態を作らない)。
//
// outbox は attestation と同じテーブルを使い、`target` で行き先を分ける。

import type Database from 'better-sqlite3';
import { acknowledgeOutbox, deferOutbox, enqueueOutbox, listDueOutbox } from '../db.ts';
import type { CernereConsentClient, RevokeConsentInput } from './cernere-consent-client.ts';

export const CONSENT_REVOKE_TARGET = 'cernere:face-consent-revoke';

/**
 * 撤回の再送を待ち行列へ入れる (ローカル削除は呼び出し側で完了済み)。
 *
 * @implements spec/plan/biometric-data-policy.md#3-削除
 */
export function enqueueConsentRevocation(db: Database.Database, input: RevokeConsentInput): void {
  enqueueOutbox(db, CONSENT_REVOKE_TARGET, JSON.stringify(input));
}

/**
 * 待ち行列の payload を撤回要求へ戻す。壊れていれば null。
 *
 * @implements spec/plan/biometric-data-policy.md#3-削除
 */
function parse(payload: string): RevokeConsentInput | null {
  try {
    const parsed = JSON.parse(payload) as Partial<RevokeConsentInput>;
    if (typeof parsed.userId !== 'string' || !parsed.userId) return null;
    return {
      userId: parsed.userId,
      consentId: typeof parsed.consentId === 'string' ? parsed.consentId : null,
      revokedBy: typeof parsed.revokedBy === 'string' ? parsed.revokedBy : '',
    };
  } catch {
    return null;
  }
}

/**
 * 期限の来た撤回を再送する。成功で削除、失敗は指数バックオフで持ち越す。
 *
 * @implements spec/plan/biometric-data-policy.md#3-削除
 */
export async function retryConsentRevocations(db: Database.Database, client: CernereConsentClient): Promise<void> {
  for (const row of listDueOutbox(db)) {
    if (row.target !== CONSENT_REVOKE_TARGET) continue;
    const input = parse(row.payload);
    if (!input) {
      // 読めない行を永久に再送し続けない。
      acknowledgeOutbox(db, row.id);
      continue;
    }
    if (await client.revokeConsent(input)) acknowledgeOutbox(db, row.id);
    else deferOutbox(db, row);
  }
}
