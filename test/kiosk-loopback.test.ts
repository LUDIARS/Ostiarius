import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { KioskAuthorization } from '../server/kiosk-authorization.ts';
import { isLoopbackAddress } from '../server/loopback.ts';

const KIOSK_TOKEN = 'test-kiosk-token';

/**
 * 認可だけを見る最小ルータ。
 *
 * `app.request()` 経由では node-server の接続情報が無いため、 接続元は常に「不明」になる
 * (= loopback 扱いしない fail-closed 経路)。 loopback 判定そのものは純関数
 * `isLoopbackAddress` 側で検証する。
 */
function app() {
  const authorization = new KioskAuthorization(KIOSK_TOKEN);
  const router = new Hono();
  router.get('/kiosk-probe', (c) => (
    authorization.isAuthorized(c) ? c.json({ ok: true }) : c.json({ error: 'kiosk_unauthorized' }, 401)
  ));
  return router;
}

describe('isLoopbackAddress', () => {
  it('accepts IPv4 loopback, IPv6 loopback, and IPv4-mapped forms', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.1.2.3')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('[::1]')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('fe80::1%eth0')).toBe(false);
  });

  it('rejects LAN addresses and anything unparsable', () => {
    expect(isLoopbackAddress('192.168.1.10')).toBe(false);
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
    // 先頭が 127 でも octet 数が合わないものは住所として認めない。
    expect(isLoopbackAddress('127.0.1')).toBe(false);
    expect(isLoopbackAddress('127.0.0.256')).toBe(false);
    expect(isLoopbackAddress('localhost')).toBe(false);
    expect(isLoopbackAddress('')).toBe(false);
    expect(isLoopbackAddress(null)).toBe(false);
  });
});

describe('KioskAuthorization', () => {
  it('does not treat an unknown remote address as loopback', async () => {
    const response = await app().request('http://localhost/kiosk-probe');
    expect(response.status).toBe(401);
  });

  it('ignores x-forwarded-for so a LAN device cannot claim to be loopback', async () => {
    const response = await app().request('http://localhost/kiosk-probe', {
      headers: { 'x-forwarded-for': '127.0.0.1' },
    });
    expect(response.status).toBe(401);
  });

  it('still accepts the shared token when the connection is not loopback', async () => {
    const response = await app().request('http://localhost/kiosk-probe', {
      headers: { 'x-ostiarius-kiosk': KIOSK_TOKEN },
    });
    expect(response.status).toBe(200);
  });
});
