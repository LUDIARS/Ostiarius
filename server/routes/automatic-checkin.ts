import { Hono, type Context } from 'hono';
import type { KeyObject } from 'node:crypto';
import { signAttestation } from '../attestation.ts';
import { verifyFacilityChallenge } from '../automatic-attendance.ts';

interface Dependencies {
  secret: string; facilityId: string; lanId: string; privateKey: KeyObject;
  isSameLan(c: Context): boolean;
  now?(): number;
}

export function makeAutomaticCheckinRouter(deps: Dependencies): Hono {
  const app = new Hono();
  const used = new Map<string, number>();
  app.post('/checkin/automatic', async c => {
    c.header('cache-control', 'no-store');
    if (!deps.isSameLan(c)) return c.json({ error: 'same_lan_required' }, 403);
    const body = await c.req.json().catch(() => null) as { challenge?: unknown } | null;
    if (typeof body?.challenge !== 'string') return c.json({ error: 'challenge_required' }, 400);
    const now = (deps.now ?? Date.now)();
    const challenge = verifyFacilityChallenge(body.challenge, deps.secret, deps.facilityId, deps.lanId, now);
    if (!challenge) return c.json({ error: 'invalid_challenge' }, 401);
    for (const [nonce, expiry] of used) if (expiry <= now) used.delete(nonce);
    if (used.has(challenge.nonce)) return c.json({ error: 'challenge_replayed' }, 409);
    if (used.size >= 10_000) return c.json({ error: 'busy' }, 503);
    used.set(challenge.nonce, challenge.expiresAt);
    return c.json({ attestation: signAttestation({
      sub: challenge.sub, placeId: deps.facilityId, lanId: deps.lanId, nonce: challenge.nonce,
      issuedAt: now, method: 'session', assurance: 'low', purpose: 'attendance',
    }, deps.privateKey) });
  });
  return app;
}
