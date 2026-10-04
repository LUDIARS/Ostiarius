# interface: HTTP エンドポイント (Ostiarius が公開する API)

Ostiarius (Hono + `@hono/node-server`) が会場 LAN 上で公開する HTTP 接点。
listen: `0.0.0.0:{OSTIARIUS_PORT}` (既定 17590)。実装: `server/index.ts`、
`server/routes/checkin.ts`。scheme は `OSTIARIUS_TLS_MODE` 次第で `http` / `https`
([feature/lan-https-and-lan-url.md](../feature/lan-https-and-lan-url.md))。

## CORS / 認証境界

- CORS は `OSTIARIUS_PWA_ORIGIN` のみ許可 (現地確認 MFA の `/api/mfa/onsite/*` は Cernere の公開 origin のみ)。
  `allowMethods: ['GET','POST','OPTIONS']`、`allowHeaders: ['content-type','authorization','x-ostiarius-nonce']`。
  許可外 Origin は `403 { error: 'origin_not_allowed' }` (`server/http-security/origin-allowlist.ts`)。
- HTTP 運用時のセキュリティ要件 (Host 許可リスト・機微経路の TLS/loopback 限定・一回限り nonce・
  レート制限・防御ヘッダ) は [feature/lan-https-and-lan-url.md](../feature/lan-https-and-lan-url.md)
  §HTTP 運用時のセキュリティ要件 が正本。共通の拒否応答:
  - `421 { error: 'misdirected_host' }` … Host が許可リスト外
  - `403 { error: 'lan_only' }` / `403 { error: 'secure_transport_required' }` … 機微経路を LAN 外 / 平文 LAN から
  - `400 { error: 'nonce_required' }` / `409 { error: 'nonce_rejected' }` … 要求 nonce の欠落 / 無効
  - `429 { error: 'rate_limited' }` + `Retry-After` … 開始・照合系の上限超過
- 通常の passkey 経路はアプリ層の Bearer を要求せず、WebAuthn assertion 自体が
  認証を担う。低保証の互換経路だけは Cernere Bearer を検証する。
  到達制御は「会場 LAN にしか配置しない」というデプロイ前提で担保する。
- 全エンドポイントは未マッチ時 `404 { error: 'not_found' }` (`app.notFound`)。

---

## `POST /checkin/begin`

同期済み公開鍵を `allowCredentials` に詰めた認証オプションを発行する。

- req body: なし。
- res 200: `generateAuthenticationOptions` の返り値そのまま
  (`@simplewebauthn/server` の `PublicKeyCredentialRequestOptionsJSON`)。主フィールド:
  - `challenge` (base64url 文字列)
  - `allowCredentials[]` (`{ id, transports? }`)
  - `rpId` (= `OSTIARIUS_RP_ID`)、`userVerification: 'required'`
- res 409: `{ error: 'no_credentials', code: 'passkey 未同期' }` — credential キャッシュ 0 件。

副作用: 発行した `challenge` を TTL 2min で保存。

## `POST /checkin/finish`

assertion を検証し、OK なら attestation を署名して返す。

- req body: `{ response: AuthenticationResponseJSON }`
  (`response.id` / `response.response.clientDataJSON` / `authenticatorData` /
  `signature` を含む WebAuthn assertion JSON)。
- res 200: `{ ok: true, attestation: string }`
  - `attestation` = `base64url(payload).base64url(sig)` (Ed25519)。payload =
    `{ sub, placeId, lanId, nonce, issuedAt, method: 'passkey', assurance: 'medium' }`。
    既存5フィールドだけの署名済み payload も検証時は読める。
- エラー:
  | status | body | 条件 |
  |---|---|---|
  | 400 | `{ error: 'bad_request', code: 'response required' }` | `response` / `response.id` 欠落 |
  | 400 | `{ error: 'bad_request', code: 'clientDataJSON invalid' }` | clientDataJSON が parse 不能 |
  | 400 | `{ error: 'challenge_expired', code: 'challenge missing/expired' }` | challenge 未保存/失効/replay |
  | 401 | `{ error: 'unknown_credential', code: 'passkey 未登録/未同期' }` | credential が DB に無い |
  | 401 | `{ error: 'assertion_failed' }` | 署名/origin/rpID 検証失敗 (検証器の内部詳細は返さない) |

## `POST /checkin/session` (互換経路、既定無効)

> TLS か loopback のときだけ受け付ける (平文 LAN は `403 secure_transport_required`)。要求 nonce 必須。

`OSTIARIUS_LEGACY_METHODS` に `session` を明示した施設だけで公開する低保証の互換経路。
有効な Cernere access token を `Authorization: Bearer {token}` または
`{ accessToken }` で受け、Cernere の `/api/auth/me` で本人を確定して attestation を返す。

- 既定では route 自体を mount せず、`404 { error: 'not_found' }`。
- res 200: `{ attestation, profile }`。入力 token は応答へ反射しない。
- res 400: `{ error: 'accessToken is required' }` — token が無い。
- res 401: `{ error }` — token が無効、または Cernere 側でユーザを確定できない。
- 詳細な保証水準と有効化方針は [feature/passkey-fallback.md](../feature/passkey-fallback.md) §5。

## `GET /gateway-public-key`

- res 200: `{ lanId, facilityId, publicKeyPem }` — 初回 provision (Aedilis 登録) 用の公開鍵。

## mobile-checkin フォールバック

- `GET /mobile-checkin` — Wi-Fi QR と email/password form を含む単一 HTML page。
- `GET /mobile-checkin/wifi-qr.png` — WPA Wi-Fi QR の PNG。SSID 未構成時は 404。
- `POST /checkin/mobile-login` — `OSTIARIUS_LEGACY_METHODS` に `password` を明示した
  施設だけで mount する低保証の互換経路 (既定は route 自体が無く `404`)。
  - req: `{ email: string, password: string }`。欠落時は 400。
  - res 200: `{ accessToken, attestation, profile }`。`attestation` は passkey 経路と同じ
    署名形式で、payload の `method` は `password` / `assurance` は `low`。
  - 認証失敗 / MFA / Cernere 不通は、credential の詳細を漏らさない利用者向けエラー (401)。
  - `profile` enrichment は best-effort で、取得不能時は `null`。

詳細: [feature/mobile-checkin-fallback.md](../feature/mobile-checkin-fallback.md)。

## `POST /api/lan/nonce`

- 状態を変える開始系 (`POST /identity/session`、`/kiosk/identity/session`、`/checkin/mobile-login`、
  `/checkin/session`) に付ける一回限りの nonce を発行する。
- res 200 (`Cache-Control: no-store`): `{ nonce, expiresAt }` (有効 3 分)。
- 使い方: 次の要求に `x-ostiarius-nonce: <nonce>` を付ける。サーバは受け取った時点で消費する。

## `GET /api/health`

- res 200: `{ ok: true, service: 'ostiarius', version, lanUrl, lanId, facilityId, credentials, methods }`
  (顔認証の稼働状況 `faceTemplates` / `facePending` / `sidecar` / `outbox` も併せて返す)
  - `credentials` = `countCredentials(db)` (キャッシュ件数)。
  - `methods` = `['passkey', ...有効化済みの session/password]`。session/password はパスワード / Bearer を
    送るので **TLS 有効時だけ** 載せる (HTTP では `403 secure_transport_required` になるため)。
  - `lanTransport` = `'http'` | `'https'` (TLS 設定)。
  - `secureContextMethods` = `['passkey', 'camera']`。画面はこの手段を secure context のときだけ出す。
  - `version` = `npm_package_version` (無ければ `'0.1.0'`)。
  - `lanUrl` = 会場 LAN のブラウザから到達できる base URL。TLS 有効時は
    `https://{OSTIARIUS_LAN_HOSTNAME}:{port}`、無効時は現在の Wi-Fi / デフォルト経路の
    プライベート IPv4。**曖昧なら誤った経路を広告せず `null`**
    ([feature/lan-https-and-lan-url.md](../feature/lan-https-and-lan-url.md))。
- 無認証。LAN のトポロジ (`lanUrl`) を含むため、この API を LAN 外に露出させない。

## 関連

- 機能詳細: [feature/checkin-verification.md](../feature/checkin-verification.md)
- mobile fallback: [feature/mobile-checkin-fallback.md](../feature/mobile-checkin-fallback.md)
- 本人確認ゲート (`/identity/*`、`method` / `assurance` 付き attestation): [interface/http-identity.md](./http-identity.md)
- `POST /identity/passkey/begin|finish` は上記 `/checkin/begin|finish` と同じ WebAuthn 検証を共有する。
- env (port / origin / rpId): [setup/configuration.md](../setup/configuration.md)
