// mobile-checkin.ts のユニットテスト。
//
// generateWifiQrPng / buildWifiQrPayload のエスケープ、 loginAndAttest の
// 成功/失敗パス (Cernere ログイン fetch をモック、 実ネットワークは使わない) を検証する。

import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

import {
  buildWifiQrPayload,
  generateWifiQrPng,
  loginAndAttest,
  type MobileCheckinDeps,
} from '../server/mobile-checkin.ts';
import { ChallengeStore } from '../server/challenge-store.ts';
import { verifyAttestation } from '../server/attestation.ts';
import type { VantanUserProfile } from '../server/vantan-user-client.ts';

describe('buildWifiQrPayload', () => {
  it('builds the standard WIFI: QR payload for plain values', () => {
    expect(buildWifiQrPayload('MyVenueWifi', 'hunter2')).toBe('WIFI:S:MyVenueWifi;T:WPA;P:hunter2;;');
  });

  it('escapes backslash, semicolon, comma, colon in SSID and password (WPA QR spec)', () => {
    const payload = buildWifiQrPayload('a;b,c:d\\e', 'p;w,o:r\\d');
    expect(payload).toBe('WIFI:S:a\\;b\\,c\\:d\\\\e;T:WPA;P:p\\;w\\,o\\:r\\\\d;;');
  });

  it('does not double-escape when a field already contains a raw backslash next to a special char', () => {
    // 1 パスの正規表現で置換するため、 元の生文字列 1 文字ずつがそれぞれ 1 回だけ
    // エスケープされる (逐次 replace のように "\\" が更に "\\\\" にはならない)。
    const payload = buildWifiQrPayload('a\\;b', '');
    expect(payload).toBe('WIFI:S:a\\\\\\;b;T:WPA;P:;;');
  });
});

describe('generateWifiQrPng', () => {
  it('produces a buffer with a valid PNG signature for plain SSID/password', async () => {
    const png = await generateWifiQrPng('MyVenueWifi', 'hunter2');
    expect(Buffer.isBuffer(png)).toBe(true);
    // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it('produces a valid PNG even when SSID/password contain WPA-QR special characters', async () => {
    const png = await generateWifiQrPng('venue;wifi,special:chars\\here', 'p:a,s;s\\word');
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });
});

function makeDeps(overrides: Partial<MobileCheckinDeps> = {}): MobileCheckinDeps {
  const pair = generateKeyPairSync('ed25519');
  return {
    cernereBaseUrl: 'https://cernere.example.com',
    facilityId: 'room-101',
    lanId: 'lan-test-1',
    challenges: new ChallengeStore(2 * 60 * 1000),
    privateKey: pair.privateKey,
    vantanUserClient: null,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('loginAndAttest', () => {
  it('returns a valid attestation on successful login (round-trips through verifyAttestation)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { user: { id: 'user-42' }, accessToken: 'tok-abc' }),
    ) as unknown as typeof fetch;
    const deps = makeDeps({ fetchImpl });

    const result = await loginAndAttest(deps, 'alice@example.com', 'correct-horse');
    expect('error' in result).toBe(false);
    if ('error' in result) throw new Error('unreachable');

    expect(result.accessToken).toBe('tok-abc');
    expect(result.profile).toBeNull();

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://cernere.example.com/api/auth/login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'alice@example.com', password: 'correct-horse' }),
      }),
    );
  });

  it('the returned attestation verifies against the gateway key pair used to sign it', async () => {
    const pair = generateKeyPairSync('ed25519');
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { user: { id: 'user-42' }, accessToken: 'tok-abc' }),
    ) as unknown as typeof fetch;
    const deps = makeDeps({ fetchImpl, privateKey: pair.privateKey });

    const result = await loginAndAttest(deps, 'alice@example.com', 'correct-horse');
    if ('error' in result) throw new Error('unreachable');

    const v = verifyAttestation(result.attestation, pair.publicKey);
    expect(v.ok).toBe(true);
    expect(v.payload?.sub).toBe('user-42');
    expect(v.payload?.placeId).toBe('room-101');
    expect(v.payload?.lanId).toBe('lan-test-1');
    expect(typeof v.payload?.nonce).toBe('string');
    expect(v.payload?.issuedAt).toBeGreaterThan(0);
  });

  it('returns a clean error on wrong credentials (Cernere HTTP non-200)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { error: 'Unauthorized' })) as unknown as typeof fetch;
    const deps = makeDeps({ fetchImpl });

    const result = await loginAndAttest(deps, 'alice@example.com', 'wrong');
    expect('error' in result).toBe(true);
    if (!('error' in result)) throw new Error('unreachable');
    expect(result.error).toMatch(/メールアドレスまたはパスワード/);
  });

  it('returns a clean, actionable error for MFA-enabled accounts (does not half-succeed)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { mfaRequired: true, mfaMethods: ['totp'] }),
    ) as unknown as typeof fetch;
    const deps = makeDeps({ fetchImpl });

    const result = await loginAndAttest(deps, 'alice@example.com', 'correct-horse');
    expect('error' in result).toBe(true);
    if (!('error' in result)) throw new Error('unreachable');
    expect(result.error).toMatch(/多要素認証|MFA/);
    expect(result.error).toMatch(/パスキー/);
  });

  it('returns a clean error when Cernere is unreachable (fetch throws)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const deps = makeDeps({ fetchImpl });

    const result = await loginAndAttest(deps, 'alice@example.com', 'correct-horse');
    expect('error' in result).toBe(true);
    if (!('error' in result)) throw new Error('unreachable');
    expect(result.error).toMatch(/接続/);
  });

  it('best-effort enriches with vantan_user profile when the client is configured', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { user: { id: 'user-42' }, accessToken: 'tok-abc' }),
    ) as unknown as typeof fetch;
    const profile: VantanUserProfile = {
      departmentName: 'ゲーム学部',
      grade: 2,
      name: '山田太郎',
      desiredJob: null,
    };
    const vantanUserClient = { getVantanUserProfile: vi.fn(async () => profile) };
    const deps = makeDeps({ fetchImpl, vantanUserClient });

    const result = await loginAndAttest(deps, 'alice@example.com', 'correct-horse');
    if ('error' in result) throw new Error('unreachable');
    expect(result.profile).toEqual(profile);
    expect(vantanUserClient.getVantanUserProfile).toHaveBeenCalledWith('user-42');
  });

  it('check-in still succeeds (profile: null) when vantan_user lookup throws', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { user: { id: 'user-42' }, accessToken: 'tok-abc' }),
    ) as unknown as typeof fetch;
    const vantanUserClient = {
      getVantanUserProfile: vi.fn(async () => {
        throw new Error('cernere project WS is not connected');
      }),
    };
    const deps = makeDeps({ fetchImpl, vantanUserClient });

    const result = await loginAndAttest(deps, 'alice@example.com', 'correct-horse');
    if ('error' in result) throw new Error('unreachable');
    expect(result.profile).toBeNull();
    expect(result.attestation).toEqual(expect.any(String));
  });
});
