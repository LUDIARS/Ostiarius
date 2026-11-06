import { randomBytes } from 'node:crypto';
import { vi } from 'vitest';
import { CompositeServiceSessions } from '../server/vendor/cernere-composite/service-session.js';
import { CocoiruSessionStore } from '../server/cocoiru-session-store.ts';
export const opaque = (): string => randomBytes(32).toString('base64url');
/** Real shared SDK permit/check/consume state machine, with only its Cr transport replaced. */
export function cocoiruAuthority(capacity = 10_000) {
  const metadata = { projectKey: 'ostiarius', user: { id: 'member', displayName: 'Member', email: null, role: 'member' },
    expiresAt: new Date(Date.now() + 600_000).toISOString() };
  const control: { beforeCall?: (action: string) => void | Promise<void> } = {};
  const call = vi.fn(async (action: string, payload: unknown): Promise<unknown> => {
    await control.beforeCall?.(action);
    const body = payload as Record<string, unknown>;
    if (action === 'bind' || action === 'check') return { ...metadata, user: { ...metadata.user } };
    if (action === 'revoke') return { revoked: true };
    if (action === 'authorize') return { permit: opaque(), expiresIn: 30, risk: 'important' };
    if (action === 'consume') return { allowed: true, requestId: body.requestId, risk: 'important' };
    throw new Error('Unexpected authority operation');
  });
  const authority = { exchange: vi.fn(async () => ({ projectToken: opaque(), user: { ...metadata.user } })),
    sessions: new CompositeServiceSessions(call) };
  const store = new CocoiruSessionStore(authority, metadata.projectKey, Date.now, capacity);
  const create = () => store.create(opaque(), opaque(), new AbortController().signal);
  return { store, create, call, authority, metadata, control };
}
