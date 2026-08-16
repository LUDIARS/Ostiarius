import { randomUUID } from 'node:crypto';
import { decodeFaceEmbedding } from './sidecar-client.ts';

export interface Enrollment { studentUserId: string; staffUserId: string; consented: boolean; consentId: string | null; embeddings: Float32Array[]; qualities: number[]; }
export class EnrollmentSessionStore {
  private readonly sessions = new Map<string, Enrollment>();
  private readonly expirations = new Map<string, number>();
  private readonly expirationTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly ttlMs = 10 * 60_000) {}

  start(studentUserId: string, staffUserId: string): string {
    this.sweep();
    const id = randomUUID();
    this.sessions.set(id, { studentUserId, staffUserId, consented: false, consentId: null, embeddings: [], qualities: [] });
    this.expirations.set(id, Date.now() + this.ttlMs);
    const timer = setTimeout(() => this.cancel(id), this.ttlMs);
    timer.unref?.();
    this.expirationTimers.set(id, timer);
    return id;
  }

  get(id: string): Enrollment | null {
    const expiresAt = this.expirations.get(id);
    if (!expiresAt || expiresAt <= Date.now()) {
      this.sessions.delete(id);
      this.expirations.delete(id);
      return null;
    }
    return this.sessions.get(id) ?? null;
  }
  consent(id: string, consentId: string): boolean { const session = this.get(id); if (!session || !consentId) return false; session.consented = true; session.consentId = consentId; return true; }
  add(id: string, encoded: string | null, quality: number): boolean { const session = this.get(id); const embedding = encoded ? decodeFaceEmbedding(encoded) : null; if (!session || !session.consented || !embedding) return false; session.embeddings.push(embedding); session.qualities.push(quality); return true; }
  take(id: string): Enrollment | null { const session = this.get(id); this.cancel(id); return session; }
  cancel(id: string): void {
    this.sessions.delete(id);
    this.expirations.delete(id);
    const timer = this.expirationTimers.get(id);
    if (timer) clearTimeout(timer);
    this.expirationTimers.delete(id);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, expiresAt] of this.expirations) {
      if (expiresAt <= now) this.cancel(id);
    }
  }
}

export function averageEmbedding(embeddings: readonly Float32Array[]): Float32Array | null {
  if (embeddings.length < 6) return null;
  const result = new Float32Array(512);
  for (const embedding of embeddings) for (let index = 0; index < result.length; index += 1) result[index] = (result[index] ?? 0) + (embedding[index] ?? 0);
  let norm = 0; for (const value of result) norm += value * value;
  if (!norm) return null; for (let index = 0; index < result.length; index += 1) result[index] = (result[index] ?? 0) / Math.sqrt(norm);
  return result;
}
