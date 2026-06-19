# interface: HTTP エンドポイント (Ostiarius が公開する API)

Ostiarius (Hono + `@hono/node-server`) が会場 LAN 上で公開する HTTP 接点。
listen: `0.0.0.0:{OSTIARIUS_PORT}` (既定 17590)。実装: `server/index.ts`、
`server/routes/checkin.ts`。

## CORS / 認証境界

- CORS は `OSTIARIUS_PWA_ORIGIN` のみ許可。`allowMethods: ['GET','POST','OPTIONS']`、
  `allowHeaders: ['content-type']` (`server/index.ts`)。
- **アプリ層の認証は無い**: 来場者の認証は WebAuthn assertion 自体が担う。
  到達制御は「会場 LAN にしか配置しない」というデプロイ前提で担保する
  (アプリは Bearer 等を要求しない)。
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
    `{ sub, placeId, lanId, nonce, issuedAt }` ([feature/checkin-verification.md](../feature/checkin-verification.md))。
- エラー:
  | status | body | 条件 |
  |---|---|---|
  | 400 | `{ error: 'bad_request', code: 'response required' }` | `response` / `response.id` 欠落 |
  | 400 | `{ error: 'bad_request', code: 'clientDataJSON invalid' }` | clientDataJSON が parse 不能 |
  | 400 | `{ error: 'challenge_expired', code: 'challenge missing/expired' }` | challenge 未保存/失効/replay |
  | 401 | `{ error: 'unknown_credential', code: 'passkey 未登録/未同期' }` | credential が DB に無い |
  | 401 | `{ error: 'assertion_failed', message? }` | 署名/origin/rpID 検証失敗 |

## `GET /gateway-public-key`

- res 200: `{ lanId, facilityId, publicKeyPem }` — 初回 provision (Aedilis 登録) 用の公開鍵。

## `GET /api/health`

- res 200: `{ ok: true, service: 'ostiarius', lanId, facilityId, credentials }`
  - `credentials` = `countCredentials(db)` (キャッシュ件数)。

## 関連

- 機能詳細: [feature/checkin-verification.md](../feature/checkin-verification.md)
- env (port / origin / rpId): [setup/configuration.md](../setup/configuration.md)
