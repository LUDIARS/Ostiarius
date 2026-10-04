// 現地確認 MFA の利用者端末向け API (契約 E)。施設 LAN 経路からだけ受ける。
//
//   POST /api/mfa/onsite/sessions        { nonce } -> 202 { sessionId, expiresAt } / 409 { error: "kiosk_busy" }
//   GET  /api/mfa/onsite/sessions/:id    -> { state, error? }
//
// Cernere のログイン画面 (別 origin) から fetch されるので、CORS は Cernere の公開 origin
// (CERNERE_FRONTEND_URL) だけを許可する。LAN の外 (中継ヘッダ付き・公開アドレス) からは
// 403 lan_required を返す。これが「現地に居る」ことの最初の条件になる。

import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { openOnsiteMfaSession, type OnsiteMfaSessionStore } from '../onsite-mfa/session-store.ts';

export const ONSITE_MFA_API_PREFIX = '/api/mfa/onsite/';

/** Cernere の nonce は 32 byte 乱数の base64url (padding なし = 43 文字)。 */
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface OnsiteMfaRouteDeps {
  sessions: OnsiteMfaSessionStore;
  /** 施設 LAN 内からの要求か (face/lan-guard.ts)。 */
  isLan: (c: Context) => boolean;
  /** Cernere の公開 origin。CORS で許可する唯一の origin。 */
  corsOrigin: string;
}

/**
 * 公開 origin のページから施設 LAN のアドレスへ fetch すると、ブラウザは Private Network
 * Access の preflight を送る。許可しないと Cernere の画面から nonce を届けられない。
 */
const allowPrivateNetwork: MiddlewareHandler = async (c, next) => {
  if (c.req.method === 'OPTIONS' && c.req.header('access-control-request-private-network') === 'true') {
    c.res.headers.set('Access-Control-Allow-Private-Network', 'true');
  }
  await next();
};

export function makeOnsiteMfaRouter(deps: OnsiteMfaRouteDeps): Hono {
  const router = new Hono();
  router.use(`${ONSITE_MFA_API_PREFIX}*`, allowPrivateNetwork);
  router.use(`${ONSITE_MFA_API_PREFIX}*`, cors({
    origin: deps.corsOrigin,
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['content-type'],
  }));

  router.post('/api/mfa/onsite/sessions', async (c) => {
    c.header('cache-control', 'no-store');
    if (!deps.isLan(c)) return c.json({ error: 'lan_required' }, 403);
    // 端末から受け取るのは nonce だけ。userId や操作内容が付いていても読まない。
    const body = (await c.req.json().catch(() => null)) as { nonce?: unknown } | null;
    const nonce = body?.nonce;
    if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) return c.json({ error: 'bad_request' }, 400);
    const opened = openOnsiteMfaSession(deps.sessions, nonce);
    if ('error' in opened) return c.json({ error: opened.error }, 409);
    return c.json(opened, 202);
  });

  router.get('/api/mfa/onsite/sessions/:sessionId', (c) => {
    c.header('cache-control', 'no-store');
    if (!deps.isLan(c)) return c.json({ error: 'lan_required' }, 403);
    const view = deps.sessions.view(c.req.param('sessionId'));
    return view ? c.json(view) : c.json({ error: 'session_not_found' }, 404);
  });
  return router;
}
