// C-15 classifyTransport(facts)
//
// 秘密や顔データを流してよい転送路は「TLS」か「中継ヘッダの無い loopback」だけ。
// 中継ヘッダがあれば接続元が 127.0.0.1 でも loopback と認めない (トンネル越しの偽装)。

import type { TransportFacts, TransportClass } from '../server/http-security/transport.ts';
import { isLoopbackAddress } from '../server/loopback.ts';

export default {
  post: (result: TransportClass, facts: TransportFacts) => {
    if (facts.tls) return result === 'tls' || 'a TLS connection must be classified as tls';
    if (facts.forwarded) return result === 'insecure' || 'a relayed plain connection must never count as loopback';
    const expected = isLoopbackAddress(facts.remoteAddress) ? 'loopback' : 'insecure';
    return result === expected || `a plain connection must be classified as ${expected}`;
  },
};
