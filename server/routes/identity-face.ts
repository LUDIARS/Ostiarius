import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import type { KeyObject } from 'node:crypto';
import { signAttestation } from '../attestation.ts';
import { deliverAttestation } from '../face/aedilis-outbox.ts';
import type { FaceVerificationFlow } from '../face/verification-flow.ts';
import type { KioskAuthorization } from '../kiosk-authorization.ts';

export function makeIdentityFaceRouter(deps: { db: Database.Database; flow: FaceVerificationFlow; authorization: KioskAuthorization; privateKey: KeyObject; lanId: string; facilityId: string; aedilisBaseUrl: string; aedilisGatewayToken: string }): Hono {
  const router = new Hono();
  router.post('/identity/face/frame', async (c) => {
    if (!deps.authorization.isAuthorized(c)) return c.json({ error: 'kiosk_unauthorized' }, 401);
    const body = await c.req.parseBody(); const sessionId = body.sessionId; const frame = body.frame;
    if (typeof sessionId !== 'string' || !(frame instanceof File) || frame.size > 200_000) return c.json({ error: 'bad_request' }, 400);
    try {
      const result = await deps.flow.process(sessionId, new Uint8Array(await frame.arrayBuffer()));
      if (!result) return c.json({ error: 'session_expired' }, 410);
      if (result.state === 'issued' && result.subjectUserId) {
        const attestation = signAttestation({ sub: result.subjectUserId, placeId: deps.facilityId, lanId: deps.lanId, nonce: sessionId, issuedAt: Date.now(), method: result.result?.assurance === 'high' ? 'face' : 'face_passive', assurance: result.result?.assurance ?? 'medium' }, deps.privateKey);
        await deliverAttestation(deps.db, deps.aedilisBaseUrl, deps.aedilisGatewayToken, attestation);
      }
      const { subjectUserId: _privateSubject, ...publicResult } = result;
      return c.json(publicResult);
    } catch { return c.json({ error: 'face_disabled' }, 409); }
  });
  return router;
}
