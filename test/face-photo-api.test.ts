// 顔写真の閲覧 API の認可と痕跡の受け入れ条件。
//
// spec/plan/biometric-data-policy.md §5:
//   - LAN 内 + 職員セッション必須 (施設外へは公開しない)
//   - 1 件ずつ (一括ダウンロードの口を作らない)
//   - Cache-Control: private, no-store
//   - 誰がどの生徒の写真を見たかを監査ログに残す
//   - 写真がディスク・ログに残らない

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../server/db.ts';
import { ChallengeStore } from '../server/challenge-store.ts';
import { loadLocalFaceKeys } from '../server/face/local-key.ts';
import { storeFacePhoto } from '../server/face/local-store.ts';
import { StaffSessionStore } from '../server/face/staff-session.ts';
import { makeIdentityStaffRouter } from '../server/routes/identity-staff.ts';

const PHOTO = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

function harness(options: { isLan?: boolean } = {}) {
  const db = openDb(':memory:');
  const keys = loadLocalFaceKeys(mkdtempSync(join(tmpdir(), 'ostiarius-photo-')));
  const sessions = new StaffSessionStore();
  const router = new Hono();
  router.route('/', makeIdentityStaffRouter({
    db,
    challenges: new ChallengeStore(60_000),
    lanId: 'lan-1',
    facilityId: 'facility-1',
    rpId: 'example.test',
    pwaOrigin: 'https://pwa.example.test',
    privateKey: generateKeyPairSync('ed25519').privateKey,
    staffRoles: ['staff', 'admin'],
    sessions,
    aedilisBaseUrl: '',
    aedilisGatewayToken: '',
    dailyOverrideLimit: 20,
    keys,
    isLan: () => options.isLan ?? true,
    syncNow: async () => ({ ok: true }),
  }));
  storeFacePhoto(db, keys, {
    userId: 'student-1', facilityId: 'facility-1', bytes: PHOTO, contentType: 'image/jpeg', consentId: 'consent-1',
  });
  return { db, keys, sessions, router };
}

function events(db: ReturnType<typeof openDb>): Array<{ kind: string; subject_user: string | null; actor_user: string | null }> {
  return db.prepare('SELECT kind, subject_user, actor_user FROM verification_events').all() as Array<{
    kind: string; subject_user: string | null; actor_user: string | null;
  }>;
}

describe('face photo API', () => {
  it('serves one photo to a staff session with private, no-store', async () => {
    const { router, sessions, db } = harness();
    const response = await router.request('/identity/face-photo/student-1', {
      headers: { 'x-ostiarius-staff': sessions.create('staff-1') },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(PHOTO));
    // 閲覧監査: 誰がどの生徒の写真を見たか。
    expect(events(db)).toContainEqual({ kind: 'photo_view', subject_user: 'student-1', actor_user: 'staff-1' });
  });

  it('refuses without a staff session', async () => {
    const { router } = harness();
    const response = await router.request('/identity/face-photo/student-1');
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('refuses from outside the facility LAN even with a staff session', async () => {
    const { router, sessions, db } = harness({ isLan: false });
    const response = await router.request('/identity/face-photo/student-1', {
      headers: { 'x-ostiarius-staff': sessions.create('staff-1') },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'lan_only' });
    // 施設外からの試行で写真を読んだ記録は作らない (実際に見せていない)。
    expect(events(db).filter((event) => event.kind === 'photo_view')).toHaveLength(0);
  });

  it('returns 404 for a user without a photo', async () => {
    const { router, sessions } = harness();
    const response = await router.request('/identity/face-photo/unknown-user', {
      headers: { 'x-ostiarius-staff': sessions.create('staff-1') },
    });
    expect(response.status).toBe(404);
  });

  it('never writes the photo to disk while serving it', async () => {
    const { router, sessions } = harness();
    const writers = [
      vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined),
      vi.spyOn(fs, 'appendFileSync').mockImplementation(() => undefined),
      vi.spyOn(fs, 'createWriteStream'),
      vi.spyOn(fsPromises, 'writeFile'),
      vi.spyOn(fsPromises, 'appendFile'),
    ];
    try {
      const response = await router.request('/identity/face-photo/student-1', {
        headers: { 'x-ostiarius-staff': sessions.create('staff-1') },
      });
      expect(response.status).toBe(200);
      for (const writer of writers) expect(writer).not.toHaveBeenCalled();
    } finally {
      for (const writer of writers) writer.mockRestore();
    }
  });

  it('requires a staff session for the immediate sync', async () => {
    const { router, sessions } = harness();
    expect((await router.request('/identity/admin/sync', { method: 'POST' })).status).toBe(401);
    const allowed = await router.request('/identity/admin/sync', {
      method: 'POST', headers: { 'x-ostiarius-staff': sessions.create('staff-1') },
    });
    expect(allowed.status).toBe(200);
  });
});
