// C-21 kioskTokenExchangeDecision(transport)
//
// kiosk 共有 token を cookie へ交換してよいのは loopback か TLS のときだけ。平文 LAN は固定の理由コードで断る。

import type { TransportClass } from '../server/http-security/transport.ts';

export default {
  post: (result: string, transport: TransportClass) => (
    transport === 'insecure'
      ? result === 'secure_transport_required' || 'a plain LAN connection must not exchange the kiosk token'
      : result === 'allowed' || 'loopback and TLS connections may exchange the kiosk token'
  ),
};
