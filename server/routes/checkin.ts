// 旧 /checkin/* 互換ルート。WebAuthn 本体は passkey-checkin.ts に一元化する。
import { Hono } from 'hono';
import type { KeyObject } from 'node:crypto';
import type Database from 'better-sqlite3';

import { ChallengeStore } from '../challenge-store.ts';
import { mountPasskeyCheckin, PasskeyCheckinService, type PasskeyCheckinDeps } from '../passkey-checkin.ts';

export interface CheckinDeps extends PasskeyCheckinDeps { publicKeyPem: string }

export function makeCheckinRouter(deps: CheckinDeps): Hono {
  const router = new Hono();
  mountPasskeyCheckin(router, { begin: '/checkin/begin', finish: '/checkin/finish' }, new PasskeyCheckinService(deps));
  router.get('/gateway-public-key', (c) => c.json({ lanId: deps.lanId, facilityId: deps.facilityId, publicKeyPem: deps.publicKeyPem }));
  return router;
}

export type { Database, KeyObject, ChallengeStore };
