// kiosk で提示する顔登録の同意文と policyVersion。
//
// 職員立会い enroll と、写真由来 pending の撮り直し承認 (reenroll) の両方が
// 同じ文言・同じ版を使うため、literal をここ 1 箇所に置く。
//
// 注: Cernere が受理する版は face-template-v1 / face-photo-v1 の 2 つ
// (Cernere/server/src/identity/face-consent-guard.ts:21-26)。ここで扱うのは
// 「テンプレートのみを保存する」経路なので template 版を使う。

export const FACE_CONSENT_POLICY_VERSION = 'face-template-v1';

export const FACE_CONSENT_TEXT =
  '顔テンプレートのみを保存し、写真は保存しません。いつでも撤回できます。';
