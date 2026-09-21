// C-8 detectLanBaseUrl(port, options)
//
// 「曖昧なまま誤った経路を広告しない」(spec/feature/lan-https-and-lan-url.md) を
// 実行時に観測する。広告してよいのは証明書ホスト名か、会場 LAN のプライベート IPv4 だけ。

import type { LanBaseUrlOptions } from '../server/lan-route.ts';

function isPrivateIpv4(host: string): boolean {
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }
  const [first, second] = octets as [number, number, number, number];
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

export default {
  pre: (port: number) => Number.isInteger(port) || 'port must be an integer',
  post: (baseUrl: string | null, port: number, options: LanBaseUrlOptions = {}) => {
    // 決められないときは null。 推測した URL を来場者に見せない。
    if (baseUrl === null) return true;
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      return 'the advertised LAN URL must be parseable';
    }
    const expectedProtocol = `${options.protocol ?? 'http'}:`;
    if (url.protocol !== expectedProtocol) return 'the advertised scheme must match the TLS mode';
    if (url.port !== String(port)) return 'the advertised port must be the listening port';
    if (options.hostname) {
      return url.hostname === options.hostname || 'the certificate hostname must be advertised verbatim';
    }
    return isPrivateIpv4(url.hostname) || 'only a private IPv4 may be advertised as the LAN URL';
  },
};
