import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { IdentitySessionStore } from '../identity-session-store.ts';
import type { KioskAuthorization } from '../kiosk-authorization.ts';
import { PasskeyCheckinService, type PasskeyCheckinDeps } from '../passkey-checkin.ts';
import { ChallengeStore } from '../challenge-store.ts';
import { proximityOriginAllowed } from '../proximity-capability.ts';

export interface KioskProximityDeps extends PasskeyCheckinDeps {
  authorization: KioskAuthorization;
  sessions: IdentitySessionStore;
}

/** @implements SPEC-OS-KIOSK-PROXIMITY-LOGIN
 * Dedicated challenge namespace: attendance only, never a Cr MFA completion. */
export function makeKioskProximityRouter(deps: KioskProximityDeps): Hono {
  const router = new Hono();
  const busy = new Set<string>();
  const passkey = new PasskeyCheckinService(
    { ...deps, challenges: new ChallengeStore(60_000) },
    id => { deps.sessions.issue(id); },
  );
  // @implements SPEC-OS-KIOSK-PROXIMITY-LOGIN
  router.use('/kiosk/proximity/*', async (c, next) => {
    c.header('cache-control', 'no-store');
    if (!deps.authorization.isAuthorized(c)) return c.json({ error: 'kiosk_unauthorized' }, 401);
    if (c.req.method !== 'GET' && (c.req.header('origin') !== deps.pwaOrigin ||
      !c.req.header('content-type')?.startsWith('application/json'))) {
      return c.json({ error: 'origin_required' }, 403);
    }
    await next();
  });
  router.use('/kiosk/proximity/*', bodyLimit({ maxSize: 32_768 }));
  // @implements SPEC-OS-KIOSK-PROXIMITY-LOGIN
  router.get('/kiosk/proximity/capabilities', c => c.json({
    passkey: proximityOriginAllowed(c.req.url, deps.pwaOrigin, deps.rpId) && Boolean(deps.sendAttendance),
    felica: false,
  }));
  // @implements SPEC-OS-KIOSK-PROXIMITY-LOGIN
  router.post('/kiosk/proximity/:sessionId/:action', async c => {
    if (!proximityOriginAllowed(c.req.url, deps.pwaOrigin, deps.rpId)) return c.json({ error: 'origin_not_supported' }, 409);
    if (!deps.sendAttendance) return c.json({ error: 'attendance_unavailable' }, 409);
    const id = c.req.param('sessionId');
    const session = deps.sessions.get(id);
    if (!session || session.state === 'issued') return c.json({ error: 'session_closed' }, 410);
    if (busy.has(id)) return c.json({ error: 'session_busy' }, 409);
    busy.add(id);
    try {
      if (c.req.param('action') === 'begin') return await passkey.begin(c, id, true);
      if (c.req.param('action') === 'finish') return await passkey.finish(c, id, () => {
        const current = deps.sessions.get(id);
        return Boolean(current && current.state !== 'issued');
      });
      return c.json({ error: 'unknown_action' }, 404);
    } finally {
      busy.delete(id);
    }
  });
  return router;
}
