// C-12 openOnsiteMfaSession(store, nonce)
//
// 1 kiosk で同時に有効な MFA セッションは 1 件だけ (契約 E)。開けたセッションは期限 5 分以内で、
// 開いた直後の有効セッションはそれ自身。断った場合は既に有効なセッションがあるか、
// 同じ nonce で開いたセッションが保持期間内に残っている (リプレイ)。

import { ONSITE_MFA_SESSION_TTL_MS, type OnsiteMfaSessionStore, type OpenOnsiteMfaResult } from '../server/onsite-mfa/session-store.ts';

export default {
  post: (result: OpenOnsiteMfaResult, store: OnsiteMfaSessionStore, nonce: string) => {
    if ('error' in result) {
      if (result.error === 'nonce_reused') return store.hasNonce(nonce) || 'nonce_reused only for a nonce already seen';
      return (result.error === 'kiosk_busy' && store.active() !== null) || 'kiosk_busy only while another session is active';
    }
    const active = store.active();
    if (active?.sessionId !== result.sessionId) return 'the opened session must be the only active one';
    const ttl = result.expiresAt - store.now();
    return (ttl > 0 && ttl <= ONSITE_MFA_SESSION_TTL_MS) || 'a session must expire within 5 minutes';
  },
};
