import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

import { remoteAddressOf, transportOf, type RemoteAddressResolver, type TransportClass } from './http-security/transport.ts';
import { contract } from '../contract-runtime.ts'; /* augur-inject:import:9d4a4580 */
import augurContract_b906d658 from '../contracts/kiosk-token-exchange-decision.contract.ts'; /* augur-inject:contract-predicate:8eb63dbe */

const KIOSK_SESSION_COOKIE = 'ostiarius_kiosk_session';
/** cookie を送る path。kiosk 画面と kiosk 用 API (`/kiosk/identity/*`、`/kiosk/mfa/*`) だけ。 */
export const KIOSK_COOKIE_PATH = '/kiosk';
const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;

export type KioskTokenExchangeDecision = 'allowed' | 'secure_transport_required';
export type KioskSessionResult = 'established' | 'unauthorized' | 'secure_transport_required';

function secretsEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

/**
 * 共有 token を cookie へ交換してよい転送路か (C-21)。平文の LAN では token 自体が
 * 盗聴できるので、交換も token での認可も認めない。
 */
export function kioskTokenExchangeDecision(transport: TransportClass): KioskTokenExchangeDecision {
  return transport === 'insecure' ? 'secure_transport_required' : 'allowed';
}
// @ts-expect-error augur-inject
kioskTokenExchangeDecision = contract(kioskTokenExchangeDecision, { ...augurContract_b906d658, contractId: 'C-21', mode: 'observe', sample: 1, where: 'server/kiosk-authorization.ts:25', rule: 'contract-wrap', id: 'b906d658' }); /* augur-inject:contract-wrap:b906d658 */

/**
 * 共有 token をブラウザへ再露出せず、短命 cookie に交換して kiosk API を認可する。
 *
 * - 同一ホスト (loopback) で中継ヘッダの無い接続は token 無しで通す (kiosk 本体)。
 *   中継ヘッダ (http-security/forwarded-headers.ts) があれば loopback でも kiosk 扱いしない。
 * - LAN の別端末は TLS 接続のときだけ token / cookie を受ける。平文 HTTP では使えない。
 */
export class KioskAuthorization {
  private readonly sessions = new Map<string, number>();

  constructor(
    private readonly sharedToken: string,
    private readonly sessionTtlMs = DEFAULT_SESSION_TTL_MS,
    private readonly resolveRemoteAddress: RemoteAddressResolver = remoteAddressOf,
  ) {
    if (!sharedToken.trim()) throw new Error('OSTIARIUS_KIOSK_TOKEN is required');
  }

  isAuthorized(c: Context): boolean {
    const transport = transportOf(c, this.resolveRemoteAddress);
    // 同一ホストのブラウザ (= kiosk 本体) はトークン無しで通す。 ブラウザはアドレスバーから
    // 任意ヘッダを送れないため、 これが無いと同一デバイス運用で kiosk 画面を開けない。
    if (transport === 'loopback') return true;
    if (transport !== 'tls') return false;

    const headerToken = c.req.header('x-ostiarius-kiosk');
    if (headerToken && secretsEqual(headerToken, this.sharedToken)) return true;

    const sessionId = getCookie(c, KIOSK_SESSION_COOKIE);
    if (!sessionId) return false;
    const expiresAt = this.sessions.get(sessionId);
    if (!expiresAt || expiresAt <= Date.now()) {
      this.sessions.delete(sessionId);
      return false;
    }
    return true;
  }

  establishBrowserSession(c: Context): KioskSessionResult {
    const transport = transportOf(c, this.resolveRemoteAddress);
    if (kioskTokenExchangeDecision(transport) !== 'allowed') return 'secure_transport_required';
    const suppliedToken = c.req.header('x-ostiarius-kiosk');
    if (!suppliedToken || !secretsEqual(suppliedToken, this.sharedToken)) return 'unauthorized';

    this.sweep();
    const sessionId = randomBytes(32).toString('base64url');
    this.sessions.set(sessionId, Date.now() + this.sessionTtlMs);
    setCookie(c, KIOSK_SESSION_COOKIE, sessionId, {
      httpOnly: true,
      maxAge: Math.floor(this.sessionTtlMs / 1000),
      path: KIOSK_COOKIE_PATH,
      sameSite: 'Strict',
      secure: transport === 'tls',
    });
    return 'established';
  }

  private sweep(): void {
    const now = Date.now();
    for (const [sessionId, expiresAt] of this.sessions) {
      if (expiresAt <= now) this.sessions.delete(sessionId);
    }
  }
}
