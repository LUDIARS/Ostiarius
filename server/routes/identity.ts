import { Hono } from 'hono';
import { toString as qrToString } from 'qrcode';

import type { IdentitySessionStore } from '../identity-session-store.ts';
import type { KioskAuthorization } from '../kiosk-authorization.ts';
import { mountPasskeyCheckin, PasskeyCheckinService, type PasskeyCheckinDeps } from '../passkey-checkin.ts';

export interface IdentityRouteDeps extends PasskeyCheckinDeps {
  cernereFrontendUrl: string;
  kioskAuthorization: KioskAuthorization;
  sessions: IdentitySessionStore;
}

export function makeIdentityRouter(deps: IdentityRouteDeps): Hono {
  const router = new Hono();
  const passkey = new PasskeyCheckinService(deps, (sessionId) => { deps.sessions.issue(sessionId); });

  router.post('/identity/session', async (c) => {
    c.header('cache-control', 'no-store');
    if (!deps.kioskAuthorization.isAuthorized(c)) return c.json({ error: 'kiosk_unauthorized' }, 401);
    const body = (await c.req.json().catch(() => null)) as { purpose?: unknown } | null;
    if (body?.purpose !== 'verify' && body?.purpose !== 'enroll') return c.json({ error: 'bad_request' }, 400);
    return c.json(deps.sessions.create());
  });
  router.get('/identity/session/:id', (c) => {
    c.header('cache-control', 'no-store');
    if (!deps.kioskAuthorization.isAuthorized(c)) return c.json({ error: 'kiosk_unauthorized' }, 401);
    const session = deps.sessions.get(c.req.param('id'));
    return session ? c.json({ state: session.state, method: session.method }) : c.json({ error: 'session_expired' }, 410);
  });
  // 生徒端末が assertion を返す公開認証面。kiosk token は QR へ載せない。
  mountPasskeyCheckin(router, { begin: '/identity/passkey/begin', finish: '/identity/passkey/finish' }, passkey, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { sessionId?: unknown } | null;
    if (body?.sessionId === undefined) return undefined;
    if (typeof body.sessionId !== 'string' || !body.sessionId) {
      return c.json({ error: 'bad_request', code: 'sessionId invalid' }, 400);
    }
    return deps.sessions.touch(body.sessionId)
      ? body.sessionId
      : c.json({ error: 'session_expired' }, 410);
  });
  router.get('/identity/passkey/register-hint', async (c) => {
    c.header('cache-control', 'no-store');
    if (!deps.kioskAuthorization.isAuthorized(c)) return c.json({ error: 'kiosk_unauthorized' }, 401);
    const registerUrl = `${deps.cernereFrontendUrl}/profile#passkey`;
    return c.json({ registerUrl, qrSvg: await qrToString(registerUrl, { type: 'svg' }) });
  });
  return router;
}
