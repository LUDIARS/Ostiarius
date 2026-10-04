// C-14 completeOnsiteMfa(deps, sessionId, identity)
//
// kiosk が確定した本人 (sub / method / assurance のみ) で 1 回だけ送信し、送信後のセッションは
// submitted か rejected になる (確認待ちに戻らない)。パスキーは medium を超えない。

import type { OnsiteMfaIdentity } from '../server/onsite-mfa/completion.ts';
import type { OnsiteMfaView } from '../server/onsite-mfa/session-store.ts';

const IDENTITY_FIELDS = new Set(['sub', 'method', 'assurance']);

export default {
  pre: (_deps: unknown, _sessionId: string, identity: OnsiteMfaIdentity) => {
    if (!Object.keys(identity).every((key) => IDENTITY_FIELDS.has(key))) return 'identity must not carry face data';
    if (identity.method === 'passkey' && identity.assurance !== 'medium') return 'a kiosk passkey is medium assurance';
    return true;
  },
  post: (view: OnsiteMfaView | null) => {
    if (view === null) return true;
    return view.state === 'submitted' || view.state === 'rejected' || 'a completed session must be submitted or rejected';
  },
};
