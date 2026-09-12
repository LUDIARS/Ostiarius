// kiosk で提示する顔登録の同意文と policyVersion、および同意の有効判定。
//
// 職員立会い enroll と、写真由来 pending の撮り直し承認 (reenroll) の両方が
// 同じ文言・同じ版を使うため、literal をここ 1 箇所に置く。
//
// 2026-09-12 (spec/plan/face-data-local-only.md §6-3): 保存先が施設の kiosk 端末のみで
// あることを同意文に明記し、policyVersion を上げた。Cernere が新版を受理するまでの間は
// 旧版 (`face-template-v1`) へフォールバックして同意記録そのものは止めない
// (cernere-consent-client.ts)。同意記録の正本は引き続き Cernere。
//
// 同意は 365 日で再同意 (spec/plan/biometric-data-policy.md §2)。Cernere が
// `consent_expired` の失効指示を積むが、不通時の保険として Ostiarius 自身でも判定する。

import type { FaceConsentCopyRow, FaceTemplateRow } from '../db.ts';

export const FACE_CONSENT_POLICY_VERSION = 'face-local-v2';

/** Cernere が新版を受理しない間に使う旧版 (順に試す)。 */
export const FACE_CONSENT_FALLBACK_POLICY_VERSIONS: readonly string[] = ['face-template-v1'];

export const FACE_CONSENT_TEXT = [
  '顔の特徴データ (テンプレート) と、職員が本人確認に使う顔写真 1 枚を保存します。',
  '保存先はこの施設の kiosk 端末のみで、施設の外 (クラウド) へは出しません。',
  '写真を見るのは施設内の職員の名簿・出席確認画面と本人だけで、kiosk の待機画面には表示しません。',
  '照合のために撮影した映像は保存しません。同意は 365 日で再確認し、いつでも撤回できます。',
].join('');

/** 同意の有効期限 (365 日)。 */
export const FACE_CONSENT_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * このテンプレートを照合に載せてよいか (同意の観点だけ)。
 *
 * 同意の写しがあればそれで判定し、まだ pull できていない場合は enroll 時刻を
 * 同意時刻とみなす (ローカル enroll は同意直後に登録されるため)。
 * Cernere 不通でも「365 日を過ぎた登録が照合に残る」ことを防ぐのが目的。
 */
export function isFaceConsentUsable(
  consent: FaceConsentCopyRow | null,
  template: Pick<FaceTemplateRow, 'enrolled_at'>,
  now: number = Date.now(),
): boolean {
  if (consent?.revoked_at) return false;
  const consentedAt = consent?.at ?? template.enrolled_at;
  return now - consentedAt <= FACE_CONSENT_MAX_AGE_MS;
}
