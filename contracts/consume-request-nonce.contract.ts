// C-19 consumeRequestNonce(store, nonce)
//
// 状態を変える LAN API の nonce は 1 回だけ使える。受理した nonce はその場で消費される。

import type { RequestNonceStore, RequestNonceOutcome } from '../server/http-security/request-nonce.ts';

export default {
  post: (result: RequestNonceOutcome, store: RequestNonceStore, nonce: string | undefined) => {
    if (!nonce) return result === 'missing' || 'an absent nonce must be reported as missing';
    if (result === 'missing') return 'a supplied nonce must not be reported as missing';
    return !store.isOutstanding(nonce) || 'a nonce must not stay usable after it is presented';
  },
};
