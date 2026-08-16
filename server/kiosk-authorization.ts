import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

const KIOSK_SESSION_COOKIE = 'ostiarius_kiosk_session';
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function secretsEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

/** 共有 token をブラウザへ再露出せず、短命 cookie に交換して kiosk API を認可する。 */
export class KioskAuthorization {
  private readonly sessions = new Map<string, number>();

  constructor(
    private readonly sharedToken: string,
    private readonly sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  ) {
    if (!sharedToken.trim()) throw new Error('OSTIARIUS_KIOSK_TOKEN is required');
  }

  isAuthorized(c: Context): boolean {
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

  establishBrowserSession(c: Context): boolean {
    const suppliedToken = c.req.header('x-ostiarius-kiosk');
    if (!suppliedToken || !secretsEqual(suppliedToken, this.sharedToken)) return false;

    this.sweep();
    const sessionId = randomBytes(32).toString('base64url');
    this.sessions.set(sessionId, Date.now() + this.sessionTtlMs);
    setCookie(c, KIOSK_SESSION_COOKIE, sessionId, {
      httpOnly: true,
      maxAge: Math.floor(this.sessionTtlMs / 1000),
      path: '/',
      sameSite: 'Strict',
      secure: new URL(c.req.url).protocol === 'https:',
    });
    return true;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [sessionId, expiresAt] of this.sessions) {
      if (expiresAt <= now) this.sessions.delete(sessionId);
    }
  }
}
