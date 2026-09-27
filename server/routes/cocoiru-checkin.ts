import { Hono } from 'hono';
import { createCocoiruLanGuard } from '../cocoiru-lan.ts';
import { tokenAndAttest, type MobileCheckinDeps } from '../mobile-checkin.ts';

export interface CocoiruCheckinDeps {
  interfaceName: string;
  login: MobileCheckinDeps;
}

/** Issues a short-lived proof for GLAB's authenticated attendance API. */
export function makeCocoiruCheckinRouter(deps: CocoiruCheckinDeps): Hono {
  const app = new Hono();
  const isSameLan = createCocoiruLanGuard(deps.interfaceName);
  app.post('/checkin/cocoiru', async (c) => {
    c.header('cache-control', 'no-store');
    if (!isSameLan(c)) return c.json({ error: 'same_lan_required' }, 403);
    const match = /^Bearer ([^\s]+)$/i.exec(c.req.header('authorization') ?? '');
    const token = match?.[1];
    if (!token || token.length > 16384) return c.json({ error: 'unauthorized' }, 401);
    // The auth request is bounded and cannot redirect a user's token to another origin.
    const issue = await tokenAndAttest({
      ...deps.login,
      vantanUserClient: null,
      fetchImpl: (input, init) => (deps.login.fetchImpl ?? fetch)(input, {
        ...init, redirect: 'error', signal: AbortSignal.timeout(10_000),
      }),
    }, token);
    if ('error' in issue) return c.json({ error: 'session_verification_failed' }, 401);
    // A proof is not a recorded attendance. GLAB verifies subject, signature, age and nonce.
    return c.json({ attestation: issue.attestation });
  });
  return app;
}
