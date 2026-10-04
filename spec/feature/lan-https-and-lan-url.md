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

## HTTP 運用時のセキュリティ要件

証明書と LAN DNS が揃うまで (2026-10-04 決定)、Ostiarius は **外部公開しない LAN 内サービスとして
HTTP で動かす**。PC は Cocoiru か GLAB から LAN 内 HTTP で使い、スマホのカメラ顔認証は
secure context が要るので HTTPS 導入後に回す。実装: `server/http-security/*` (組み込みは
`installLanHardening`、`server/index.ts`)。

### 脅威の前提

共有 Wi-Fi 上の **受動的な盗聴** と、**能動的な改ざん** (ARP 偽装など) を想定する。HTTP のページ
そのものの改ざんは原理的に防げないので、次の 3 点を満たすことを目標にする。

- 盗まれても使えない (一回限りの nonce・短命 cookie・Ed25519 署名)
- 改ざんされても下流で検出できる (Aedilis / Cernere が attestation の Ed25519 署名を検証する)
- 秘密と個人データを平文で流さない

### 要件

| # | 要件 | 実装 |
|---|---|---|
| 1 | kiosk 共有 token → cookie の交換と token / cookie による認可は **loopback か TLS** のときだけ。平文 LAN は交換を `403 secure_transport_required`、API を `401 kiosk_unauthorized` で断る | `kiosk-authorization.ts` (`kioskTokenExchangeDecision`) |
| 2 | 顔写真・顔フレーム・テンプレート・登録 (`/identity/enroll/*`)・審査・職員セッション・パスワード / Bearer の互換経路は **施設 LAN 内 かつ TLS か loopback**。LAN 外は `403 lan_only`、平文 LAN は `403 secure_transport_required` | `sensitive-route-guard.ts` / `lan-routes.ts`、`face/lan-guard.ts` の `createSecureLanGuard` |
| 3 | LAN 向け応答に照合に不要な個人データ (氏名・メール) を載せない。モバイル互換経路の `profile` は学科・学年だけ | `routes/mobile-checkin.ts` の `publicProfile` |
| 4 | 状態を変える開始系 (`POST /identity/session`、`/kiosk/identity/session`、`/checkin/mobile-login`、`/checkin/session`) は `POST /api/lan/nonce` で発行した **3 分・一回限り** の nonce を `x-ostiarius-nonce` で必須にする。欠落 `400 nonce_required`、未発行・期限切れ・再利用 `409 nonce_rejected` | `request-nonce.ts` (保存は `ChallengeStore`) |
| 5 | 現地確認 MFA の開始は Cernere 発行の nonce を一回限りで受ける。保持期間内の再送は `409 nonce_reused` | `onsite-mfa/session-store.ts` |
| 6 | WebAuthn の begin/finish は challenge 自体がサーバ発行の一回限り nonce なので追加 nonce を要求しない。attestation は従来通り Ed25519 で署名し、下流が検証する | `passkey-checkin.ts` / `attestation.ts` |
| 7 | **Host 許可リスト** (DNS リバインディング対策): 検出した LAN IPv4、`localhost` / `127.0.0.1` / `[::1]`、`OSTIARIUS_LAN_HOSTNAME`。port は省略か待受 port。外れたら `421 misdirected_host` | `host-allowlist.ts` |
| 8 | 転送ヘッダ (`x-forwarded-for` / `x-forwarded-host` / `x-forwarded-proto` / `forwarded` / `cf-connecting-ip` / `cf-ray` / `x-real-ip`) は共通定義。1 つでもあれば LAN 外扱いで、loopback でも kiosk と認めない | `forwarded-headers.ts` (lan-guard / kiosk-authorization / cocoiru-lan が共有) |
| 9 | CORS は明示 Origin の許可リストのみ (PWA origin、現地確認 MFA は Cernere の公開 origin)。ワイルドカードは起動時に拒否。許可外 Origin は preflight も本要求も `403 origin_not_allowed`。資格情報付き CORS は返さない | `origin-allowlist.ts` |
| 10 | 全応答に CSP (`default-src 'self'`、inline script は応答ごとの nonce)、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、未指定なら `Cache-Control: no-store` | `security-headers.ts` |
| 11 | kiosk cookie は `HttpOnly`・`SameSite=Strict`・`Path=/kiosk`・1 時間 (TLS 時は `Secure`)。kiosk 画面は `/kiosk/identity/*` から identity API を使う | `kiosk-authorization.ts`、`index.ts` の `/kiosk` mount |
| 12 | ブラウザ側で `window.isSecureContext` が false ならパスキーとカメラの手段を出さず、kiosk での顔認証・Cocoiru・GLAB 経由を案内する。`/api/health` は `lanTransport` と `secureContextMethods` を返し、互換経路 (password / session) は TLS 時だけ `methods` に載せる | `secure-context.ts`、`routes/kiosk.ts`、`routes/mobile-checkin.ts` |
| 13 | LAN 向けの開始・照合系 API に IP 単位のレート制限 (既定 30 回 / 60 秒、メモリ上)。超過は `429 rate_limited` + `Retry-After`。kiosk 本体 (loopback) は対象外 | `rate-limit.ts` |

GLAB (HTTPS) から HTTP の Ostiarius への fetch は混在コンテンツで遮断されるので、GLAB からは
`lanUrl` へのリンク遷移 (トップレベル navigation) で画面を開く。

### 残余リスク

- **能動的 MITM によるページ改ざん**: HTTP では配信した HTML / JS を書き換えられる。nonce と CSP は
  リプレイと外部スクリプト注入を抑えるが、改ざんされたページ自体は防げない。秘密と顔データは
  平文 LAN に流さない設計で被害を「偽の画面を見せられる」範囲に留め、出席・MFA の成立は下流の
  Ed25519 検証で担保する。
- **LAN 内の盗聴**: 開始系の要求 (nonce・セッション id) は読める。一回限り・短命なので再利用はできない。
- **推奨する運用**: 会場 Wi-Fi は WPA2/WPA3 + クライアント分離 (AP isolation) を有効にする。
- **将来**: 証明書と LAN DNS を用意して `OSTIARIUS_TLS_MODE=required` に切り替える
  ([feature/lan-tls-certificate.md](lan-tls-certificate.md))。切替後はスマホのカメラ顔認証・パスキー・
  LAN 別端末の kiosk が使えるようになる。

## 制約 / 前提

- 証明書・秘密鍵は secret。Excubitor の Vault から inject し、平文ファイルを置かない
  ([setup/secrets.md](../setup/secrets.md))。
- `lanUrl` は会場 LAN のトポロジ情報なので、Ostiarius を LAN 外へ公開しないこと自体が前提。
- TLS を `required` にしたら、Excubitor catalog の health URL / `provides` も
  `https://` + `OSTIARIUS_LAN_HOSTNAME` に揃える必要がある (`excubitor.catalog.yaml`)。

## 関連

- 証明書の発行 / 更新: [feature/lan-tls-certificate.md](lan-tls-certificate.md)
- env 一覧: [setup/configuration.md](../setup/configuration.md)
- secret 供給: [setup/secrets.md](../setup/secrets.md)
- health レスポンス形: [interface/http-checkin.md](../interface/http-checkin.md)
