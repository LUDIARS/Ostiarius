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
import type { AttendanceSender } from './attendance-delivery.ts';

export interface PasskeyCheckinDeps {
  db: Database.Database;
  challenges: ChallengeStore;
  lanId: string;
  facilityId: string;
  rpId: string;
  pwaOrigin: string;
  privateKey: KeyObject;
  sendAttendance?: AttendanceSender;
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

function isCanonicalBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value;
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

/** assertion 検証で確定した本人と、検証に使った challenge / kiosk セッション。 */
export interface VerifiedAssertion {
  userId: string;
  challenge: string;
  sessionId?: string;
}

/** WebAuthn begin/finish の共通実装。旧checkinとidentity別名の差分はroute側だけに限定する。 */
export class PasskeyCheckinService {
  private readonly sessionByChallenge = new Map<string, { sessionId: string; expiresAt: number }>();

  constructor(
    private readonly deps: PasskeyCheckinDeps,
    private readonly onIssued?: (sessionId: string) => void,
    private readonly onVerified?: (userId: string) => void,
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

  /**
   * assertion を同期済み公開鍵だけで検証し、本人 (Cernere user id) を確定する。
   * attestation の署名・送信はしない。用途 (出席 / 現地確認 MFA) ごとに呼び出し側が決める。
   */
  async verifyAssertion(c: Context): Promise<VerifiedAssertion | Response> {
    const body = (await c.req.json().catch(() => null)) as
      | { response?: AuthenticationResponseJSON }
      | null;
    const response = body?.response;
    if (!response || typeof response.id !== 'string') {
      return c.json({ error: 'bad_request', code: 'response required' }, 400);
    }
    if (!isCanonicalBase64Url(response.response.signature)) {
      return c.json({ error: 'assertion_failed' }, 401);
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
    return { userId: credential.user_id, challenge, sessionId };
  }

  async finish(c: Context): Promise<Response> {
    const verified = await this.verifyAssertion(c);
    if (verified instanceof Response) return verified;
    const { userId, challenge, sessionId } = verified;
    const attestation = signAttestation(
      {
        sub: userId,
        placeId: this.deps.facilityId,
        lanId: this.deps.lanId,
        nonce: challenge,
        issuedAt: Date.now(),
        method: 'passkey',
        assurance: 'medium',
        purpose: 'attendance',
      },
      this.deps.privateKey,
    );
    recordVerificationIssued(this.deps.db, {
      method: 'passkey',
      subjectUser: userId,
      sessionId,
    });
    const attendance = await this.deps.sendAttendance?.(attestation);
    if (attendance?.status === 'failed') return c.json({ ok: false, error: '出席記録を確認できませんでした。管理者に確認してください。', attendance }, 502);
    if (sessionId) this.onIssued?.(sessionId);
    this.onVerified?.(userId);
    return c.json({ ok: true, attestation, attendance, method: 'passkey', assurance: 'medium' });
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
