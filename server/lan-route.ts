import { createSocket, type Socket } from 'node:dgram';
import { isIPv4 } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { contract } from '../contract-runtime.ts'; /* augur-inject:import:f2e3768d */
import augurContract_5156871c from '../contracts/detect-lan-base-url.contract.ts'; /* augur-inject:contract-predicate:91f725fa */

type InterfaceMap = NodeJS.Dict<NetworkInterfaceInfo[]>;

export interface LanRouteDetectionOptions {
  interfaces?: InterfaceMap;
  detectDefaultRouteAddress?: () => Promise<string | null>;
}

export interface LanBaseUrlOptions extends LanRouteDetectionOptions {
  protocol?: 'http' | 'https';
  hostname?: string;
}

const WIFI_INTERFACE_PATTERN = /(?:wi-?fi|wireless|wlan)/i;

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (
    octets.length !== 4
    || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) return false;
  const [first, second] = octets;
  if (first === undefined || second === undefined) return false;
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

function candidates(interfaces: InterfaceMap): Array<{ name: string; address: string }> {
  return Object.entries(interfaces).flatMap(([name, entries]) =>
    (entries ?? [])
      .filter((entry) => entry.family === 'IPv4' && !entry.internal && isPrivateIpv4(entry.address))
      .map((entry) => ({ name, address: entry.address })),
  );
}

function closeDgramSocket(socket: Socket): void {
  try {
    socket.close();
  } catch {
    // connect 前は未 bind のことがある。遅延 callback が来た場合にも再度 close する。
  }
}

function connectedIpv4(socket: Socket): string | null {
  try {
    const address = socket.address();
    return typeof address === 'object' && isIPv4(address.address) ? address.address : null;
  } catch {
    return null;
  }
}

/** UDP connect はパケットを送らず、OS の現在のデフォルト経路から送信元 IPv4 を選ばせる。 */
export function detectDefaultRouteAddress(): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    let settled = false;
    const finish = (address: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      closeDgramSocket(socket);
      resolve(address);
    };
    const timeout = setTimeout(() => finish(null), 500);
    socket.once('error', () => finish(null));
    try {
      socket.connect(53, '1.1.1.1', () => {
        // timeout/error 後の callback では閉じた socket の address() を参照しない。
        if (settled) {
          closeDgramSocket(socket);
          return;
        }
        finish(connectedIpv4(socket));
      });
    } catch {
      finish(null);
    }
  });
}

/** 会場端末が現在接続している Wi-Fi/LAN 上でブラウザから到達できる IPv4 を返す。 */
export async function detectLanIpv4(options: LanRouteDetectionOptions = {}): Promise<string | null> {
  const available = candidates(options.interfaces ?? networkInterfaces());
  const wifi = available.find((entry) => WIFI_INTERFACE_PATTERN.test(entry.name));
  if (wifi) return wifi.address;

  const routeAddress = await (options.detectDefaultRouteAddress ?? detectDefaultRouteAddress)();
  if (routeAddress && available.some((entry) => entry.address === routeAddress)) return routeAddress;
  return available.length === 1 ? available[0]?.address ?? null : null;
}

export async function detectLanBaseUrl(
  port: number,
  options: LanBaseUrlOptions = {},
): Promise<string | null> {
  const protocol = options.protocol ?? 'http';
  if (options.hostname) return `${protocol}://${options.hostname}:${port}`;
  const address = await detectLanIpv4(options);
  return address ? `${protocol}://${address}:${port}` : null;
}
// @ts-expect-error augur-inject
detectLanBaseUrl = contract(detectLanBaseUrl, { ...augurContract_5156871c, contractId: 'C-8', mode: 'observe', sample: 1, where: 'server/lan-route.ts:97', rule: 'contract-wrap', id: '5156871c' }); /* augur-inject:contract-wrap:5156871c */

const LAN_BASE_URL_TTL_MS = 60_000;

/**
 * `/api/health` は Excubitor が定期的に叩く無認証エンドポイントなので、 リクエスト毎に
 * UDP socket を張らないよう検出結果を TTL キャッシュする (会場の接続先が変わっても
 * TTL 経過後の再検出で追従する)。 同時リクエストは 1 回の検出に相乗りさせる。
 */
export function createLanBaseUrlResolver(
  port: number,
  options: LanBaseUrlOptions & { ttlMs?: number; now?: () => number } = {},
): () => Promise<string | null> {
  const ttlMs = options.ttlMs ?? LAN_BASE_URL_TTL_MS;
  const now = options.now ?? Date.now;
  let cache: { value: string | null; expiresAt: number } | undefined;
  let inFlight: Promise<string | null> | undefined;

  return async (): Promise<string | null> => {
    if (cache && now() < cache.expiresAt) return cache.value;
    const pending =
      inFlight
      ?? (inFlight = detectLanBaseUrl(port, options).finally(() => {
        inFlight = undefined;
      }));
    const value = await pending;
    cache = { value, expiresAt: now() + ttlMs };
    return value;
  };
}
