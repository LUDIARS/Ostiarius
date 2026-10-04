// 現地確認 MFA の kiosk 側 API。kiosk 画面の「確認待ち」と本人確定に使う (kiosk 認可必須)。
//
//   GET  /kiosk/mfa/current                        -> { session: { sessionId, expiresAt } | null }
//   POST /kiosk/mfa/:sessionId/face/frame          form { identitySessionId, frame }
//   POST /kiosk/mfa/:sessionId/passkey/begin       -> WebAuthn options
//   POST /kiosk/mfa/:sessionId/passkey/finish      { response } -> { mfa: { state, error? } }
//
// 本人の確定は既存の顔 1:N + 生体性 (FaceVerificationFlow) とパスキー検証
// (PasskeyCheckinService.verifyAssertion) を使う。確定後は completeOnsiteMfa が purpose:"mfa"
// で署名し Cernere へだけ送る。出席 (Aedilis) へは送らない。応答に照合した user id を載せない。

import { Hono } from 'hono';
import { completeOnsiteMfa, type OnsiteMfaCompletionDeps } from '../onsite-mfa/completion.ts';
import type { FaceVerificationFlow } from '../face/verification-flow.ts';
import type { KioskAuthorization } from '../kiosk-authorization.ts';
import type { PasskeyCheckinService } from '../passkey-checkin.ts';

export interface OnsiteMfaKioskDeps {
  authorization: KioskAuthorization;
  completion: OnsiteMfaCompletionDeps;
  flow: FaceVerificationFlow;
  /** sendAttendance を持たない (出席を送らない) インスタンスを渡す。 */
  passkey: PasskeyCheckinService;
}

export function makeOnsiteMfaKioskRouter(deps: OnsiteMfaKioskDeps): Hono {
  const router = new Hono();
  const sessions = deps.completion.sessions;
  const isWaiting = (sessionId: string): boolean => sessions.view(sessionId)?.state === 'waiting';

  router.use('/kiosk/mfa/*', async (c, next) => {
    c.header('cache-control', 'no-store');
    if (!deps.authorization.isAuthorized(c)) return c.json({ error: 'kiosk_unauthorized' }, 401);
    await next();
  });

  router.get('/kiosk/mfa/current', (c) => {
    const active = sessions.active();
    // nonce は kiosk 画面にも出さない (画面越しの盗み見で別端末に渡されないように)。
    return c.json({ session: active ? { sessionId: active.sessionId, expiresAt: active.expiresAt } : null });
  });

  router.post('/kiosk/mfa/:sessionId/face/frame', async (c) => {
    const mfaSessionId = c.req.param('sessionId');
    if (!isWaiting(mfaSessionId)) return c.json({ error: 'mfa_session_closed', mfa: sessions.view(mfaSessionId) }, 409);
    const body = await c.req.parseBody();
    const identitySessionId = body.identitySessionId;
    const frame = body.frame;
    if (typeof identitySessionId !== 'string' || !(frame instanceof File) || frame.size > 200_000) return c.json({ error: 'bad_request' }, 400);
    let result;
    try {
      result = await deps.flow.process(identitySessionId, new Uint8Array(await frame.arrayBuffer()));
    } catch {
      return c.json({ error: 'face_disabled' }, 409);
    }
    if (!result) return c.json({ error: 'session_expired' }, 410);
    const { subjectUserId, ...publicResult } = result;
    if (result.state !== 'issued' || !subjectUserId) return c.json(publicResult);
    const assurance = result.result?.assurance ?? 'medium';
    const mfa = await completeOnsiteMfa(deps.completion, mfaSessionId, {
      sub: subjectUserId,
      method: assurance === 'high' ? 'face' : 'face_passive',
      assurance,
    });
    return c.json({ ...publicResult, mfa: mfa ?? sessions.view(mfaSessionId) });
  });

  router.post('/kiosk/mfa/:sessionId/passkey/begin', async (c) => {
    const mfaSessionId = c.req.param('sessionId');
    if (!isWaiting(mfaSessionId)) return c.json({ error: 'mfa_session_closed', mfa: sessions.view(mfaSessionId) }, 409);
    return deps.passkey.begin(c, mfaSessionId);
  });

  router.post('/kiosk/mfa/:sessionId/passkey/finish', async (c) => {
    const mfaSessionId = c.req.param('sessionId');
    const verified = await deps.passkey.verifyAssertion(c);
    if (verified instanceof Response) return verified;
    // begin で束縛した MFA セッション以外には使わせない。
    if (verified.sessionId !== mfaSessionId) return c.json({ error: 'challenge_mismatch' }, 400);
    const mfa = await completeOnsiteMfa(deps.completion, mfaSessionId, { sub: verified.userId, method: 'passkey', assurance: 'medium' });
    if (!mfa) return c.json({ error: 'mfa_session_closed', mfa: sessions.view(mfaSessionId) }, 409);
    return c.json({ mfa });
  });
  return router;
}
