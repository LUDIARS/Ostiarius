// /checkin/* + /gateway-public-key — Ostiarius の本体 API。
//
// CONTRACTS.md §3 API:
//   POST /checkin/begin   → generateAuthenticationOptions (synced 公開鍵を allow)。
//                           challenge を TTL 2min で短命保存。 返り = options。
//   POST /checkin/finish  → verifyAuthenticationResponse (synced 公開鍵で)。
//                           OK なら credentialId→userId を引き、 attestation 署名して返す。
//   GET  /gateway-public-key → { lanId, facilityId, publicKeyPem } (初回 provision 用)。
//
// passkey の使い方は Cernere server/src/http/passkey-handler.ts と同じ
// (generateAuthenticationOptions / verifyAuthenticationResponse、
//  credential.publicKey は Uint8Array)。

import { Hono } from 'hono';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import type Database from 'better-sqlite3';
import type { KeyObject } from 'node:crypto';

import {
  getCredential,
  listCredentials,
  updateCredentialCounter,
} from '../db.ts';
import { ChallengeStore } from '../challenge-store.ts';
import { signAttestation } from '../attestation.ts';

export interface CheckinDeps {
  db: Database.Database;
  challenges: ChallengeStore;
  lanId: string;
  facilityId: string;
  rpId: string;
  pwaOrigin: string;
  privateKey: KeyObject;
  publicKeyPem: string;
}

function parseTransports(json: string): AuthenticatorTransportFuture[] | undefined {
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) && arr.length > 0
      ? (arr as AuthenticatorTransportFuture[])
      : undefined;
  } catch {
    return undefined;
  }
}

export function makeCheckinRouter(deps: CheckinDeps): Hono {
  const r = new Hono();

  // nonce 発行 — 同期済み全 credential を allow に詰める (usernameless 風)
  r.post('/checkin/begin', async (c) => {
    deps.challenges.sweep();
    const creds = listCredentials(deps.db);
    if (creds.length === 0) {
      return c.json({ error: 'no_credentials', code: 'passkey 未同期' }, 409);
    }
    const options = await generateAuthenticationOptions({
      rpID: deps.rpId,
      userVerification: 'required',
      allowCredentials: creds.map((cred) => ({
        id: cred.credential_id,
        transports: parseTransports(cred.transports),
      })),
    });
    deps.challenges.put(options.challenge);
    return c.json(options);
  });

  // assertion オフライン検証 → attestation 署名
  r.post('/checkin/finish', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { response?: AuthenticationResponseJSON }
      | null;
    const response = body?.response;
    if (!response || typeof response.id !== 'string') {
      return c.json({ error: 'bad_request', code: 'response required' }, 400);
    }

    const cred = getCredential(deps.db, response.id);
    if (!cred) {
      return c.json({ error: 'unknown_credential', code: 'passkey 未登録/未同期' }, 401);
    }

    // クライアントが返した challenge を clientDataJSON から取り出して 1-shot 消費
    // (TTL + replay 防止)。 challenge は WebAuthn 仕様で base64url 文字列。
    let challenge: string;
    try {
      const clientData = JSON.parse(
        Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8'),
      ) as { challenge?: unknown };
      challenge = typeof clientData.challenge === 'string' ? clientData.challenge : '';
    } catch {
      return c.json({ error: 'bad_request', code: 'clientDataJSON invalid' }, 400);
    }
    if (!challenge || !deps.challenges.consume(challenge)) {
      return c.json({ error: 'challenge_expired', code: 'challenge missing/expired' }, 400);
    }

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: deps.pwaOrigin,
        expectedRPID: deps.rpId,
        requireUserVerification: true,
        credential: {
          id: cred.credential_id,
          publicKey: new Uint8Array(Buffer.from(cred.public_key, 'base64')),
          counter: cred.counter,
          transports: parseTransports(cred.transports),
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: 'assertion_failed', message: msg }, 401);
    }

    if (!verification.verified) {
      return c.json({ error: 'assertion_failed' }, 401);
    }

    // counter は best-effort。 後退 (clone 徴候) は warn のみ、 hard fail しない
    // (passkey は counter=0 固定が多い)。
    const newCounter = verification.authenticationInfo.newCounter;
    if (newCounter < cred.counter) {
      console.warn(
        `[ostiarius] counter 後退検知 cred=${cred.credential_id.slice(0, 12)}… ` +
          `stored=${cred.counter} new=${newCounter} (clone の可能性、 best-effort で継続)`,
      );
    }
    if (newCounter > cred.counter) {
      updateCredentialCounter(deps.db, cred.credential_id, newCounter);
    }

    const attestation = signAttestation(
      {
        sub: cred.user_id,
        placeId: deps.facilityId,
        lanId: deps.lanId,
        nonce: challenge,
        issuedAt: Date.now(),
      },
      deps.privateKey,
    );
    console.log(`[ostiarius] check-in verified user=${cred.user_id} → attestation issued`);
    return c.json({ ok: true, attestation });
  });

  // 初回 provision 用 — 運用者が Aedilis の gateway_registry に登録する公開鍵
  r.get('/gateway-public-key', (c) =>
    c.json({
      lanId: deps.lanId,
      facilityId: deps.facilityId,
      publicKeyPem: deps.publicKeyPem,
    }),
  );

  return r;
}
