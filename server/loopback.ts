/**
 * 同一ホスト (loopback) からの接続かどうかの判定。
 *
 * kiosk は Ostiarius ホスト上のブラウザで動く (spec/feature/identity-verification.md §5)。
 * その端末に触れること自体が信頼境界なので、共有トークンが締め出す相手は
 * 「同じ LAN にいる別端末」だけになる。判定を純関数として切り出しておくのは、
 * 認可の分岐 (kiosk-authorization.ts) と住所の取り出し方 (HTTP サーバ実装) を
 * 別々に差し替え・検証できるようにするため。
 *
 * プロキシヘッダ (`x-forwarded-for` 等) は見ない。Ostiarius は LAN から直接叩かれる
 * 前提で、ヘッダを信じると LAN 内の任意の端末が loopback を名乗れてしまう。
 */

/**
 * IPv4 / IPv6 の loopback (`127.0.0.0/8`、`::1`、IPv4-mapped) なら true。
 *
 * @implements spec/feature/identity-verification.md#5-kiosk-フロー-主経路
 */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  // `[::1]` の角括弧と `%eth0` の zone id を落としてから比較する。
  const normalized = address.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  const withoutZone = normalized.split('%')[0] ?? '';
  if (withoutZone === '::1') return true;
  // IPv4-mapped IPv6 (`::ffff:127.0.0.1`) は IPv4 として評価する。
  const candidate = withoutZone.startsWith('::ffff:') ? withoutZone.slice('::ffff:'.length) : withoutZone;
  const octets = candidate.split('.');
  if (octets.length !== 4) return false;
  if (!octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)) return false;
  return octets[0] === '127';
}
