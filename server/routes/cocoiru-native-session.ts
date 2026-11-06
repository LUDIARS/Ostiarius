/** Native service-credential HTTP boundary; no cookie/global-token compatibility.
 * @implements SPEC-OS-COCOIRU-SCOPED-NATIVE-001
 */
import { Hono, type Context } from 'hono';
import { CocoiruSessionError, type CocoiruSessionStore } from '../cocoiru-session-store.ts';
export const nativeBearer = (c: Context): string | undefined => /^Bearer ([A-Za-z0-9_-]{43})$/.exec(c.req.header('authorization') ?? '')?.[1];
export function makeCocoiruNativeSessionRouter(sessions: CocoiruSessionStore, isSameLan: (c: Context) => boolean): Hono {
  const router = new Hono();
  router.post('/api/auth/native/exchange', async c => {
    if (!isSameLan(c)) return c.json({ error: 'same_lan_required' }, 403);
    if (c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return c.json({ error: 'json_required' }, 415);
    let input: unknown;
    try { input = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return c.json({ error: 'invalid_native_exchange' }, 400);
    const value = input as Record<string, unknown>;
    if (Object.keys(value).some(key => key !== 'code' && key !== 'code_verifier')
      || typeof value.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.code)
      || typeof value.code_verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(value.code_verifier)) return c.json({ error: 'code_and_s256_verifier_required' }, 400);
    const previous = nativeBearer(c);
    if (c.req.header('authorization') && !previous) return c.json({ error: 'native_session_required' }, 401);
    const created = await sessions.create(value.code, value.code_verifier, c.req.raw.signal, previous);
    if (!isSameLan(c)) { await sessions.revoke(created.sessionToken); throw new CocoiruSessionError(403, 'same_lan_required'); }
    return c.json(created);
  });
  router.post('/api/auth/native/logout', async c => {
    const token = nativeBearer(c);
    if (!token) return c.json({ error: 'native_session_required' }, 401);
    await sessions.revoke(token);
    return c.json({ ok: true });
  });
  return router;
}
