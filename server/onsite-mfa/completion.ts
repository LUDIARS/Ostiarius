// kiosk で本人が確定した後の処理: purpose:"mfa" で署名し、Cernere へだけ送って状態を進める。
//
// 出席 (Aedilis) へは送らない。MFA 用 attestation を出席に流用させないため
// (spec/feature/onsite-mfa-factor.md §3)。

import type { KeyObject } from 'node:crypto';
import { signAttestation } from '../attestation.ts';
import type { OnsiteMfaSubmitResult, OnsiteMfaSubmitter } from './cernere-submit.ts';
import type { OnsiteMfaSessionStore, OnsiteMfaView } from './session-store.ts';
import { contract } from '../contract-runtime.ts'; /* augur-inject:import:31faf814 */
import augurContract_21d1fc38 from '../../contracts/complete-onsite-mfa.contract.ts'; /* augur-inject:contract-predicate:570b741c */

/** kiosk の照合で確定した本人。顔画像・テンプレート・スコアは含めない。 */
export interface OnsiteMfaIdentity {
  sub: string;
  method: 'face' | 'face_passive' | 'passkey';
  assurance: 'high' | 'medium';
}

export interface OnsiteMfaCompletionDeps {
  sessions: OnsiteMfaSessionStore;
  privateKey: KeyObject;
  lanId: string;
  facilityId: string;
  submit: OnsiteMfaSubmitter;
}

/** 確認待ちでないセッション (期限切れ・送信済み・不明) なら null。 */
export async function completeOnsiteMfa(
  deps: OnsiteMfaCompletionDeps,
  sessionId: string,
  identity: OnsiteMfaIdentity,
): Promise<OnsiteMfaView | null> {
  const session = deps.sessions.claim(sessionId);
  if (!session) return null;
  const attestation = signAttestation({
    sub: identity.sub,
    placeId: deps.facilityId,
    lanId: deps.lanId,
    nonce: session.nonce,
    issuedAt: deps.sessions.now(),
    method: identity.method,
    assurance: identity.assurance,
    purpose: 'mfa',
  }, deps.privateKey);
  let result: OnsiteMfaSubmitResult;
  try {
    result = await deps.submit(attestation);
  } catch {
    result = { status: 'rejected', error: 'submit_failed' };
  }
  deps.sessions.settle(sessionId, result.status === 'accepted' ? { state: 'submitted' } : { state: 'rejected', error: result.error });
  return deps.sessions.view(sessionId);
}
// @ts-expect-error augur-inject
completeOnsiteMfa = contract(completeOnsiteMfa, { ...augurContract_21d1fc38, contractId: 'C-14', mode: 'observe', sample: 1, where: 'server/onsite-mfa/completion.ts:27', rule: 'contract-wrap', id: '21d1fc38' }); /* augur-inject:contract-wrap:21d1fc38 */
