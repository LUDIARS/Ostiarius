# feature: LAN 内 HTTPS と LAN URL の広告

会場 LAN 内のブラウザから Ostiarius へ **HTTPS で** 直接到達させるための TLS 設定解決と、
「いまこの端末はどの URL で来場者に見せられるか」の自動検出。

- 実装: `server/tls-config.ts` (TLS 設定の解決)、`server/lan-route.ts` (LAN URL 検出)
- 適用: `server/config.ts` (`config.tls`)、`server/index.ts` (listen / `GET /api/health`)
- 公開: `GET /api/health` の `lanUrl` ([interface/http-checkin.md](../interface/http-checkin.md))
- テスト: `test/tls-config.test.ts` / `test/lan-route.test.ts`
- 証明書の発行 / 更新はこの機能の**外側**: `npm run tls:issue` / `tls:renew`
  ([feature/lan-tls-certificate.md](lan-tls-certificate.md))。ここは発行済みの PEM を
  受け取って配信するだけで、ACME も Cloudflare も呼ばない。

## 目的

- WebAuthn は secure context を要求するため、来場者のスマホから使う `/checkin/*` は
  HTTPS で配信する必要がある。会場 LAN 上の端末に **公開 CA 証明書**
  (`tls:issue` が ACME DNS-01 で取得したもの) を inject し、`OSTIARIUS_LAN_HOSTNAME` を
  LAN DNS でその端末のプライベート IP に解決させる。`OSTIARIUS_LAN_HOSTNAME` は発行 CLI と
  配信側で同じ値を使う (証明書の CN / SAN と広告する URL が食い違わないようにする)。
- Cloudflare Tunnel 等で公開はしない。到達制御は「会場 LAN にしか置かない」で担保する
  ([interface/http-checkin.md](../interface/http-checkin.md) の認証境界)。

## TLS 設定の解決 (`resolveTlsConfig`)

- `OSTIARIUS_TLS_MODE` は `off` (既定) か `required` のみ。他の値は **throw** して起動を止める
  (誤記で意図せず平文起動するのを防ぐ)。
- `off` → `{ enabled: false }` (dev の HTTP 起動)。
- `required` → `OSTIARIUS_LAN_HOSTNAME` / `OSTIARIUS_TLS_CERTIFICATE_PEM` /
  `OSTIARIUS_TLS_PRIVATE_KEY_PEM` の 3 値が **すべて** 必要。1 つでも欠けたら
  欠けた key 名だけを挙げて throw する (**値はログに出さない**)。
- `OSTIARIUS_LAN_HOSTNAME` は scheme / port / path を含まない DNS hostname のみ。
  URL として不正な広告値を作らないよう、違反時は値を出さずに throw する。
- **HTTP へフォールバックしない**: TLS を要求した構成が不完全なら起動失敗が正しい。
- `server/index.ts` は `enabled` のとき `node:https` の `createServer` + `{ cert, key }` で
  listen する。

## LAN URL の検出 (`detectLanIpv4` / `detectLanBaseUrl`)

`hostname` (= TLS 有効時の証明書ホスト名) が与えられていればそれをそのまま使う。
無ければ現在の接続先から IPv4 を推定する:

1. 候補は **プライベート IPv4** (`10/8`、`172.16–31/12`、`192.168/16`) かつ非 internal のみ。
   公開 IP・loopback・link-local は候補にしない。
2. インターフェース名が `wi-fi` / `wireless` / `wlan` に一致するものを最優先 (会場 Wi-Fi)。
3. 無ければ OS の現在のデフォルト経路の送信元 IPv4 (`detectDefaultRouteAddress`) を使う。
   UDP socket の `connect` は**パケットを送らず**送信元アドレスだけを OS に選ばせる
   (500ms でタイムアウト、失敗は `null`)。候補一覧に含まれる場合のみ採用する。
4. それでも決まらないときは、候補がちょうど 1 つならそれ、複数なら **`null`**
   — 曖昧なまま誤った経路 (VPN 等) を広告しない。

`GET /api/health` は無認証で Excubitor が定期的に叩くため、検出結果は
`createLanBaseUrlResolver` が TTL 60s でキャッシュし、同時リクエストは 1 回の検出に
相乗りさせる (リクエスト毎に UDP socket を張らない)。TTL 経過後は再検出するので、
会場の接続先が変わっても追従する。

## 制約 / 前提

- 証明書・秘密鍵は secret。Infisical から inject し、平文ファイルを置かない
  ([setup/secrets.md](../setup/secrets.md))。
- `lanUrl` は会場 LAN のトポロジ情報なので、Ostiarius を LAN 外へ公開しないこと自体が前提。
- TLS を `required` にしたら、Excubitor catalog の health URL / `provides` も
  `https://` + `OSTIARIUS_LAN_HOSTNAME` に揃える必要がある (`excubitor.catalog.yaml`)。

## 関連

- 証明書の発行 / 更新: [feature/lan-tls-certificate.md](lan-tls-certificate.md)
- env 一覧: [setup/configuration.md](../setup/configuration.md)
- secret 供給: [setup/secrets.md](../setup/secrets.md)
- health レスポンス形: [interface/http-checkin.md](../interface/http-checkin.md)
