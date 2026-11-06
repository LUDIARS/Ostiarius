/** Process-owned opaque native sessions; live authorization belongs to the Cr SDK.
 * @implements SPEC-OS-COCOIRU-SCOPED-NATIVE-001
 */
import { createHash, randomBytes } from 'node:crypto';
import type { CernereComposite } from './vendor/cernere-composite/composite.js';
import { CompositeAuthorityError, type BoundServiceSession, type ServiceOperation } from './vendor/cernere-composite/service-session.js';

type Authority = Pick<CernereComposite, 'exchange' | 'sessions'>;
interface Entry { grant: BoundServiceSession; expiresAt: number }
export class CocoiruSessionError extends Error {
  constructor(readonly status: 401 | 403 | 408 | 503, readonly code: string) { super(code); }
}
const opaque = (value: string): boolean => /^[A-Za-z0-9_-]{43}$/.test(value);
const fingerprint = (value: string): string => createHash('sha256').update(value, 'utf8').digest('base64url');

export class CocoiruSessionStore {
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  private pending = 0;
  constructor(private readonly authority: Authority, private readonly projectKey: string,
    private readonly now: () => number = Date.now, private readonly capacity = 10_000,
    private readonly randomToken = () => randomBytes(32).toString('base64url')) {
    if (!projectKey || !Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Project key and session capacity required');
  }
  async create(code: string, verifier: string, signal: AbortSignal, previous?: string): Promise<{ sessionToken: string; expiresAt: string }> {
    this.assertOpen(signal);
    if (!opaque(code) || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new CocoiruSessionError(401, 'invalid_native_exchange');
    this.sweep();
    if (this.entries.size + this.pending >= this.capacity || this.pending >= 32) throw new CocoiruSessionError(503, 'native_session_capacity');
    this.pending++;
    let grant: BoundServiceSession | undefined, published = false;
    try {
      if (previous) await this.revoke(previous);
      this.assertOpen(signal);
      const exchanged = await this.authority.exchange(code, verifier);
      this.assertOpen(signal);
      const token = this.randomToken();
      if (!opaque(token) || this.entries.has(fingerprint(token))) throw new Error('Native session entropy collision');
      grant = await this.authority.sessions.bind(exchanged.projectToken, token);
      this.assertOpen(signal);
      const expiry = Date.parse(grant.expiresAt), key = fingerprint(token);
      if (grant.projectKey !== this.projectKey || grant.user.id !== exchanged.user.id || grant.user.role !== exchanged.user.role
        || grant.sessionBinding !== key || !Number.isFinite(expiry) || expiry <= this.now() || expiry > this.now() + 900_000
        || this.entries.has(key)) throw new CocoiruSessionError(401, 'invalid_native_session_binding');
      this.entries.set(key, { grant, expiresAt: expiry });
      published = true;
      return { sessionToken: token, expiresAt: grant.expiresAt };
    } catch (error) {
      if (grant && !published) {
        try { await this.authority.sessions.revoke(grant); }
        catch { throw new CocoiruSessionError(503, 'native_exchange_revocation_unconfirmed'); }
      }
      throw error;
    } finally { this.pending--; }
  }
  async run<T>(token: string, operation: ServiceOperation, signal: AbortSignal,
    authorize: (userId: string) => boolean, execute: (userId: string, isCurrent: () => boolean) => T): Promise<T> {
    const key = fingerprint(token), entry = this.entry(token, signal);
    try {
      const checked = await this.authority.sessions.check(entry.grant);
      this.assertEntry(key, entry, signal);
      const expiresAt = Date.parse(checked.expiresAt);
      if (checked.projectKey !== this.projectKey || checked.user.id !== entry.grant.user.id || checked.user.role !== entry.grant.user.role
        || checked.sessionBinding !== entry.grant.sessionBinding || !Number.isFinite(expiresAt) || expiresAt > entry.expiresAt || expiresAt <= this.now()) {
        this.entries.delete(key); throw new CocoiruSessionError(401, 'native_session_changed');
      }
      entry.grant = checked; entry.expiresAt = expiresAt;
      const current = (): boolean => !this.closed && !signal.aborted && this.entries.get(key) === entry && entry.expiresAt > this.now();
      return await this.authority.sessions.run(checked, operation, {
        risk: 'important',
        authorizeResource: () => { this.assertEntry(key, entry, signal); return authorize(checked.user.id) && current(); },
        execute: () => {
          this.assertEntry(key, entry, signal);
          if (!authorize(checked.user.id)) throw new CocoiruSessionError(401, 'native_resource_owner_ended');
          return execute(checked.user.id, current);
        },
      });
    } catch (error) {
      if (error instanceof CompositeAuthorityError && [401, 403].includes(error.status)) this.entries.delete(key);
      throw error;
    }
  }
  async revoke(token: string): Promise<void> {
    if (!opaque(token)) throw new CocoiruSessionError(401, 'native_session_required');
    const key = fingerprint(token), entry = this.entries.get(key);
    this.entries.delete(key); // Final locally, including while permit preparation is in flight.
    if (entry && entry.expiresAt > this.now()) await this.authority.sessions.revoke(entry.grant);
  }
  close(): void { this.closed = true; this.entries.clear(); }
  private entry(token: string, signal: AbortSignal): Entry {
    if (!opaque(token)) throw new CocoiruSessionError(401, 'native_session_required');
    const key = fingerprint(token), entry = this.entries.get(key);
    if (!entry) throw new CocoiruSessionError(401, 'native_session_required');
    this.assertEntry(key, entry, signal); return entry;
  }
  private assertEntry(key: string, entry: Entry, signal: AbortSignal): void {
    this.assertOpen(signal);
    if (this.entries.get(key) !== entry || entry.expiresAt <= this.now()) throw new CocoiruSessionError(401, 'native_session_ended');
  }
  private assertOpen(signal: AbortSignal): void {
    if (signal.aborted) throw new CocoiruSessionError(408, 'native_request_ended');
    if (this.closed) throw new CocoiruSessionError(401, 'native_session_ended');
  }
  private sweep(): void { for (const [key, entry] of this.entries) if (entry.expiresAt <= this.now()) this.entries.delete(key); }
}
