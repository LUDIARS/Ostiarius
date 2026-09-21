import { describe, expect, it } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import { createLanBaseUrlResolver, detectLanBaseUrl, detectLanIpv4 } from '../server/lan-route.ts';

function ipv4(address: string): NetworkInterfaceInfo {
  return { address, netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: `${address}/24` };
}

describe('LAN route detection', () => {
  it('prefers the connected Wi-Fi interface over other private interfaces', async () => {
    await expect(detectLanIpv4({
      interfaces: { Ethernet: [ipv4('192.168.1.10')], 'Wi-Fi': [ipv4('192.168.50.20')] },
      detectDefaultRouteAddress: async () => '192.168.1.10',
    })).resolves.toBe('192.168.50.20');
  });

  it('uses the OS default route when the interface name is platform-specific', async () => {
    await expect(detectLanBaseUrl(17590, {
      interfaces: { en0: [ipv4('192.168.50.20')], en1: [ipv4('10.0.0.8')] },
      detectDefaultRouteAddress: async () => '192.168.50.20',
    })).resolves.toBe('http://192.168.50.20:17590');
  });

  it('advertises the certificate hostname when LAN HTTPS is enabled', async () => {
    await expect(detectLanBaseUrl(17590, {
      protocol: 'https',
      hostname: 'ostiarius.example.test',
      interfaces: {},
    })).resolves.toBe('https://ostiarius.example.test:17590');
  });

  it('does not advertise a public, loopback, or ambiguous address', async () => {
    await expect(detectLanIpv4({
      interfaces: { Ethernet: [ipv4('192.168.1.10')], VPN: [ipv4('10.0.0.8')] },
      detectDefaultRouteAddress: async () => '203.0.113.10',
    })).resolves.toBeNull();
  });

  it('rejects out-of-range IPv4 octets reported by an injected interface map', async () => {
    await expect(detectLanIpv4({
      interfaces: { Ethernet: [ipv4('10.999.0.1')] },
      detectDefaultRouteAddress: async () => '10.999.0.1',
    })).resolves.toBeNull();
  });

  it('detects at most once per TTL so /api/health does not probe the route per request', async () => {
    let now = 0;
    let detections = 0;
    const resolve = createLanBaseUrlResolver(17590, {
      interfaces: { en0: [ipv4('192.168.50.20')], en1: [ipv4('10.0.0.8')] },
      detectDefaultRouteAddress: async () => {
        detections++;
        return '192.168.50.20';
      },
      ttlMs: 60_000,
      now: () => now,
    });

    // 同時呼び出し + TTL 内の再呼び出しは 1 回の検出に相乗りする。
    const [a, b] = await Promise.all([resolve(), resolve()]);
    expect(a).toBe('http://192.168.50.20:17590');
    expect(b).toBe('http://192.168.50.20:17590');
    await expect(resolve()).resolves.toBe('http://192.168.50.20:17590');
    expect(detections).toBe(1);

    // TTL 経過後は会場の接続先変更に追従するため再検出する。
    now += 60_001;
    await expect(resolve()).resolves.toBe('http://192.168.50.20:17590');
    expect(detections).toBe(2);
  });
});
