// LAN 向け API の分類表。どの経路に何を要求するかをここ 1 か所に置く。
//
// - SENSITIVE: 秘密 (職員セッション・パスワード・Bearer) か顔データ (写真・フレーム・テンプレート)
//   が流れる経路。施設 LAN 内 かつ 転送路が TLS か loopback でなければ断る。
// - NONCE_REQUIRED: 状態を変える開始系で、Ostiarius 自身が配信する画面から呼ぶもの。
//   サーバ発行の一回限り nonce を必須にする。WebAuthn の begin/finish は challenge 自体が
//   サーバ発行の一回限り nonce なので対象外。現地確認 MFA の開始は Cernere 発行の nonce を
//   一回限りで受ける (onsite-mfa/session-store.ts の nonce_reused)。
// - RATE_LIMITED: 開始・照合系 (総当たり・大量発行の対象)。顔フレームは対象外 (loopback の
//   kiosk が毎秒数回送るため。そもそも SENSITIVE で LAN 平文からは届かない)。

import type { Context } from 'hono';

const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /^\/(?:kiosk\/)?identity\/face\/frame$/,
  /^\/kiosk\/mfa\/[^/]+\/face\/frame$/,
  /^\/identity\/enroll(?:\/|$)/,
  /^\/identity\/face-photo(?:\/|$)/,
  /^\/identity\/review(?:\/|$)/,
  /^\/identity\/staff(?:\/|$)/,
  /^\/identity\/admin(?:\/|$)/,
  /^\/checkin\/mobile-login$/,
  /^\/checkin\/session$/,
  /^\/checkin\/cocoiru$/,
];

const NONCE_REQUIRED_POST: readonly RegExp[] = [
  /^\/(?:kiosk\/)?identity\/session$/,
  /^\/checkin\/mobile-login$/,
  /^\/checkin\/session$/,
];

const RATE_LIMITED_POST: readonly RegExp[] = [
  /^\/api\/lan\/nonce$/,
  /^\/api\/mfa\/onsite\/sessions$/,
  /^\/(?:kiosk\/)?identity\/session$/,
  /^\/(?:kiosk\/)?identity\/passkey\/(?:begin|finish)$/,
  /^\/identity\/staff\/(?:begin|finish)$/,
  /^\/identity\/enroll\/start$/,
  /^\/kiosk\/mfa\/[^/]+\/passkey\/(?:begin|finish)$/,
  /^\/checkin\/(?:begin|finish|mobile-login|session|cocoiru)$/,
];

const matches = (patterns: readonly RegExp[], path: string): boolean => patterns.some((pattern) => pattern.test(path));

export const isSensitiveRoute = (c: Context): boolean => matches(SENSITIVE_PATTERNS, c.req.path);
export const requiresRequestNonce = (c: Context): boolean => c.req.method === 'POST' && matches(NONCE_REQUIRED_POST, c.req.path);
export const isRateLimitedRoute = (c: Context): boolean => c.req.method === 'POST' && matches(RATE_LIMITED_POST, c.req.path);
