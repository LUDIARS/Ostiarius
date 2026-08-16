import { randomUUID } from 'node:crypto';

export type IdentitySessionState = 'idle' | 'scanning' | 'challenging' | 'issued' | 'fallback' | 'expired';

interface IdentitySession {
  expiresAt: number;
  state: IdentitySessionState;
  method?: 'passkey' | 'face' | 'face_passive' | 'staff_override';
}

/** kiosk 用の短命セッション。外部状態を持たず、再起動時は安全に失効する。 */
export class IdentitySessionStore {
  private readonly sessions = new Map<string, IdentitySession>();

  constructor(private readonly ttlMs = 60_000) {}

  create(): { sessionId: string; expiresAt: number } {
    this.sweep();
    const sessionId = randomUUID();
    const expiresAt = Date.now() + this.ttlMs;
    this.sessions.set(sessionId, { expiresAt, state: 'idle' });
    return { sessionId, expiresAt };
  }

  get(sessionId: string): IdentitySession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(sessionId);
      return null;
    }
    return session;
  }

  /** 有効な操作を受けたセッションだけ TTL を延長する。状態ポーリングでは延長しない。 */
  touch(sessionId: string): boolean {
    const session = this.get(sessionId);
    if (!session) return false;
    session.expiresAt = Date.now() + this.ttlMs;
    return true;
  }

  issue(sessionId: string): boolean {
    const session = this.get(sessionId);
    if (!session) return false;
    session.state = 'issued';
    session.method = 'passkey';
    session.expiresAt = Date.now() + this.ttlMs;
    return true;
  }

  transition(sessionId: string, state: Exclude<IdentitySessionState, 'expired'>, method?: IdentitySession['method']): boolean {
    const session = this.get(sessionId);
    if (!session) return false;
    session.state = state;
    if (method) session.method = method;
    session.expiresAt = Date.now() + this.ttlMs;
    return true;
  }

  sweep(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(id);
  }
}
