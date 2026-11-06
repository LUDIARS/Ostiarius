// Cernere の画面 (公開 origin) から施設 LAN の Os へ fetch すると、ブラウザは Private Network
// Access の preflight を送る。許可しないと Cernere の画面から nonce を届けられない。
// 現地確認 MFA (routes/onsite-mfa.ts) と会場登録 (routes/venue-registration.ts) の端末向け API で共有する。

import type { MiddlewareHandler } from 'hono';

export const allowPrivateNetwork: MiddlewareHandler = async (c, next) => {
  if (c.req.method === 'OPTIONS' && c.req.header('access-control-request-private-network') === 'true') {
    c.res.headers.set('Access-Control-Allow-Private-Network', 'true');
  }
  await next();
};

/** Cernere が発行する nonce は 32 byte 乱数の base64url (padding なし = 43 文字)。 */
export const CERNERE_NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
