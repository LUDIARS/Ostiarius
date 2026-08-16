import { randomBytes } from 'node:crypto';

/** Staff passkey verification establishes a short-lived capability for privileged kiosk actions. */
export class StaffSessionStore {
  private readonly sessions = new Map<string, { userId: string; expiresAt: number }>();

  create(userId: string): string {
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, { userId, expiresAt: Date.now() + 10 * 60_000 });
    return token;
  }

  get(token: string | undefined): string | null {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) { this.sessions.delete(token); return null; }
    return session.userId;
  }
}
