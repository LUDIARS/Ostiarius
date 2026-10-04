// 逆プロキシ・トンネル (Cloudflare Tunnel 等) を経由したことを示すヘッダの共通定義。
//
// Ostiarius は LAN から直接叩かれる前提なので、これらが 1 つでも付いていれば
// 「施設外からの中継」とみなす。値は信じない (LAN の端末が自由に付けられる) が、
// **付いていること** は loopback / LAN の特権を外す方向にだけ使う (fail-closed)。
// lan-guard / kiosk-authorization / cocoiru-lan が同じ一覧を使う。

export const FORWARDED_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'forwarded',
  'cf-connecting-ip',
  'cf-ray',
  'x-real-ip',
] as const;

/** 中継を示すヘッダが 1 つでも付いていれば true。 */
export function hasForwardedHeaders(headers: Headers): boolean {
  return FORWARDED_HEADERS.some((name) => headers.has(name));
}
