import { Hono, type Context } from 'hono';
import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import type Database from 'better-sqlite3';
import type { KeyObject } from 'node:crypto';

import {
  getCredential,
  listCredentials,
  recordVerificationIssued,
  updateCredentialCounter,
  type CredentialRow,
} from './db.ts';
import { ChallengeStore } from './challenge-store.ts';
import { signAttestation } from './attestation.ts';

export interface PasskeyCheckinDeps {
  db: Database.Database;
  challenges: ChallengeStore;
  lanId: string;
  facilityId: string;
  rpId: string;
  pwaOrigin: string;
  privateKey: KeyObject;
}

function parseTransports(json: string): AuthenticatorTransportFuture[] | undefined {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) && value.length > 0
      ? value as AuthenticatorTransportFuture[]
      : undefined;
  } catch {
    return undefined;
  }
}

function parseChallenge(response: AuthenticationResponseJSON): string | null {
  try {
    const data = JSON.parse(
      Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8'),
    ) as { challenge?: unknown };
    return typeof data.challenge === 'string' && data.challenge ? data.challenge : null;
  } catch {
    return null;
  }
}

function updateCounter(
  db: Database.Database,
  credential: CredentialRow,
  counter: number,
): void {
  if (counter < credential.counter) {
    console.warn(
      `[ostiarius] counter 後退検知 cred=${credential.credential_id.slice(0, 12)}… ` +
        `stored=${credential.counter} new=${counter} (clone の可能性、 best-effort で継続)`,
    );
  }
  if (counter > credential.counter) {
    updateCredentialCounter(db, credential.credential_id, counter);
  }
}

/** WebAuthn begin/finish の共通実装。旧checkinとidentity別名の差分はroute側だけに限定する。 */
export class PasskeyCheckinService {
  private readonly sessionByChallenge = new Map<string, { sessionId: string; expiresAt: number }>();

  constructor(
    private readonly deps: PasskeyCheckinDeps,
    private readonly onIssued?: (sessionId: string) => void,
  ) {}

  async begin(c: Context, sessionId?: string): Promise<Response> {
    this.deps.challenges.sweep();
    this.sweepSessionBindings();
    const credentials = listCredentials(this.deps.db);
    if (credentials.length === 0) {
      return c.json({ error: 'no_credentials', code: 'passkey 未同期' }, 409);
    }
    const options = await generateAuthenticationOptions({
      rpID: this.deps.rpId,
      userVerification: 'required',
      allowCredentials: credentials.map((credential) => ({
        id: credential.credential_id,
        transports: parseTransports(credential.transports),
      })),
    });
    const expiresAt = this.deps.challenges.put(options.challenge);
    if (sessionId) this.sessionByChallenge.set(options.challenge, { sessionId, expiresAt });
    return c.json(options);
  }

  async finish(c: Context): Promise<Response> {
    const body = (await c.req.json().catch(() => null)) as
      | { response?: AuthenticationResponseJSON }
      | null;
    const response = body?.response;
    if (!response || typeof response.id !== 'string') {
      return c.json({ error: 'bad_request', code: 'response required' }, 400);
    }
    const credential = getCredential(this.deps.db, response.id);
    if (!credential) {
      return c.json({ error: 'unknown_credential', code: 'passkey 未登録/未同期' }, 401);
    }
    const challenge = parseChallenge(response);
    if (!challenge) {
      return c.json({ error: 'bad_request', code: 'clientDataJSON invalid' }, 400);
    }
    const sessionId = this.takeSessionId(challenge);
    if (!this.deps.challenges.consume(challenge)) {
      return c.json(
        { error: 'challenge_expired', code: 'challenge missing/expired' },
        400,
      );
    }
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: this.deps.pwaOrigin,
        expectedRPID: this.deps.rpId,
        requireUserVerification: true,
        credential: {
          id: credential.credential_id,
          publicKey: new Uint8Array(Buffer.from(credential.public_key, 'base64')),
          counter: credential.counter,
          transports: parseTransports(credential.transports),
        },
      });
    } catch {
      return c.json({ error: 'assertion_failed' }, 401);
    }
    if (!verification.verified) return c.json({ error: 'assertion_failed' }, 401);
    updateCounter(this.deps.db, credential, verification.authenticationInfo.newCounter);
    const attestation = signAttestation(
      {
        sub: credential.user_id,
        placeId: this.deps.facilityId,
        lanId: this.deps.lanId,
        nonce: challenge,
        issuedAt: Date.now(),
        method: 'passkey',
        assurance: 'medium',
      },
      this.deps.privateKey,
    );
    recordVerificationIssued(this.deps.db, {
      method: 'passkey',
      subjectUser: credential.user_id,
      sessionId,
    });
    if (sessionId) this.onIssued?.(sessionId);
    return c.json({ ok: true, attestation, method: 'passkey', assurance: 'medium' });
  }

  private takeSessionId(challenge: string): string | undefined {
    const binding = this.sessionByChallenge.get(challenge);
    this.sessionByChallenge.delete(challenge);
    return binding && binding.expiresAt > Date.now() ? binding.sessionId : undefined;
  }

  private sweepSessionBindings(): void {
    const now = Date.now();
    for (const [challenge, binding] of this.sessionByChallenge) {
      if (binding.expiresAt <= now) this.sessionByChallenge.delete(challenge);
    }
  }
}

type SessionIdResolver = (c: Context) => Promise<string | undefined | Response>;

export function mountPasskeyCheckin(
  router: Hono,
  paths: { begin: string; finish: string },
  service: PasskeyCheckinService,
  getSessionId?: SessionIdResolver,
): void {
  router.post(paths.begin, async (c) => {
    const sessionId = getSessionId ? await getSessionId(c) : undefined;
    if (sessionId instanceof Response) return sessionId;
    return service.begin(c, sessionId);
  });
  router.post(paths.finish, async (c) => service.finish(c));
}
