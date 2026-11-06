/** @implements SPEC-OS-COCOIRU-SCOPED-NATIVE-001 */
import { randomBytes, type KeyObject } from 'node:crypto';
import type Database from 'better-sqlite3';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createCocoiruLanGuard } from '../cocoiru-lan.ts';
import { CocoiruSessionError, type CocoiruSessionStore } from '../cocoiru-session-store.ts';
import { CompositeAuthorityError } from '../vendor/cernere-composite/service-session.js';
import { signAttestation } from '../attestation.ts';
import { recordVerificationIssued } from '../db.ts';
import type { ChallengeStore } from '../challenge-store.ts';
import { makeCocoiruNativeSessionRouter, nativeBearer } from './cocoiru-native-session.ts';

export interface CocoiruCheckinDeps {
  interfaceName: string;
  publicOrigin: string;
  sessions: CocoiruSessionStore;
  facilityId: string; lanId: string; privateKey: KeyObject; db: Database.Database; challenges: ChallengeStore;
  isSameLan?: (c: Context) => boolean;
}

/** Issues a short-lived proof for GLAB's authenticated attendance API. */
export function makeCocoiruCheckinRouter(deps: CocoiruCheckinDeps): Hono {
  let origin: URL;
  try { origin = new URL(deps.publicOrigin); } catch { throw new Error('Canonical HTTPS native origin required'); }
  if (origin.protocol !== 'https:' || origin.origin !== deps.publicOrigin || origin.username || origin.password) throw new Error('Canonical HTTPS native origin required');
  const app = new Hono();
  const isSameLan = deps.isSameLan ?? createCocoiruLanGuard(deps.interfaceName);
  for (const path of ['/checkin/cocoiru', '/api/auth/native/exchange', '/api/auth/native/logout']) {
    app.use(path, async (c, next) => {
      c.header('cache-control', 'private, no-store');
      const supplied = c.req.header('origin');
      if (supplied !== undefined && supplied !== deps.publicOrigin) return c.json({ error: 'invalid_native_origin' }, 403);
      if (new URL(c.req.url).search) return c.json({ error: 'native_query_not_supported' }, 400);
      await next();
    }, bodyLimit({ maxSize: 4096, onError: c => c.json({ error: 'native_body_too_large' }, 413) }));
  }
  app.route('/', makeCocoiruNativeSessionRouter(deps.sessions, isSameLan));
  app.post('/checkin/cocoiru', async (c) => {
    if (!isSameLan(c)) return c.json({ error: 'same_lan_required' }, 403);
    const token = nativeBearer(c);
    if (!token) return c.json({ error: 'native_session_required' }, 401);
    if (c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return c.json({ error: 'json_required' }, 415);
    const body = await c.req.text();
    let input: unknown;
    try { input = JSON.parse(body); } catch { return c.json({ error: 'invalid_json' }, 400); }
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 0) return c.json({ error: 'empty_attendance_request_required' }, 400);
    const authorize = (): boolean => {
      if (!isSameLan(c)) throw new CocoiruSessionError(403, 'same_lan_required');
      if (c.req.raw.signal.aborted) throw new CocoiruSessionError(408, 'native_request_ended');
      return true;
    };
    const issue = await deps.sessions.run(token, { action: 'attendance.cocoiru.attest',
      resource: 'facility:' + deps.facilityId + ':lan:' + deps.lanId + ':attendance', body }, c.req.raw.signal, authorize, (userId, current) => {
      const requireCurrent = (): void => {
        authorize();
        if (!current()) throw new CocoiruSessionError(401, 'native_session_ended');
      };
      const issued = deps.db.transaction(() => {
        requireCurrent();
        const nonce = randomBytes(32).toString('base64url');
        const attestation = signAttestation({ sub: userId, placeId: deps.facilityId, lanId: deps.lanId, nonce,
          issuedAt: Date.now(), method: 'session', assurance: 'low', purpose: 'attendance' }, deps.privateKey);
        recordVerificationIssued(deps.db, { method: 'session', subjectUser: userId });
        requireCurrent();
        return { nonce, attestation };
      })();
      deps.challenges.sweep(); deps.challenges.put(issued.nonce);
      return { attestation: issued.attestation };
    });
    // A proof is not a recorded attendance. GLAB verifies subject, signature, age and nonce.
    return c.json({ attestation: issue.attestation });
  });
  app.onError((error, c) => {
    if (error instanceof CocoiruSessionError) return c.json({ error: error.code, retryable: false }, error.status);
    if (error instanceof CompositeAuthorityError && error.status < 500) return c.json({ error: 'native_authority_denied', retryable: false }, 401);
    return c.json({ error: 'native_attendance_result_unconfirmed', retryable: false }, 503);
  });
  return app;
}
