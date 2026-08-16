# setup: 環境変数 / 起動

Ostiarius の前提・env・ローカル起動手順。env 解決は `server/config.ts`、
env-cli (Infisical) 設定は `env-cli.config.ts`。

## 前提

- Node.js (CI は 24.14.1)。
- 依存: `hono` / `@hono/node-server` / `@simplewebauthn/server` / `better-sqlite3` / `tsx`
  (`package.json`)。`npm install` で導入 (`better-sqlite3` はネイティブビルドあり)。
- 配置: 会場 LAN の PC / Raspberry Pi に置く (= 自宅から到達不能にするのが設計前提)。

## 環境変数

`server/config.ts` の解決順。**必須** は未設定だと `requireEnv` が `process.exit(1)`。
それ以外は default を許す。

| key | 役割 | 既定 | 必須 |
|---|---|---|---|
| `OSTIARIUS_PORT` | listen port | `17590` | |
| `OSTIARIUS_LAN_ID` | ゲートウェイ ID (attestation.lanId) | — | **必須** |
| `OSTIARIUS_FACILITY_ID` | 紐づく施設 (attestation.placeId) | — | **必須** |
| `CERNERE_BASE_URL` | passkey export 取得元 (末尾 `/` 除去) | — | **必須** |
| `CERNERE_SERVICE_TOKEN` | export 用 admin/service Bearer (**secret**) | — | **必須** |
| `OSTIARIUS_RP_ID` | WebAuthn rpID (Cernere と同 eTLD+1) | — | **必須** |
| `OSTIARIUS_PWA_ORIGIN` | CORS 許可 + expectedOrigin の PWA origin | — | **必須** |
| `OSTIARIUS_PRIVATE_KEY` | Ed25519 秘密鍵 PKCS#8 PEM。本番は inject (**secret**) | `''` (空→file 経路) | 本番 必須 |
| `OSTIARIUS_KEY_PATH` | dev 用 秘密鍵ファイル (env 未設定時、無ければ生成) | `{dataDir}/gateway.key` | |
| `AEDILIS_BASE_URL` | 公開鍵 自己登録先 (末尾 `/` 除去) | `''` (空=手動) | |
| `AEDILIS_ADMIN_TOKEN` | 自己登録 admin Bearer (**secret**) | `''` (空=手動) | |
| `OSTIARIUS_LABEL` | Aedilis に出す表示ラベル | `''` | |
| `OSTIARIUS_DATA` | data ディレクトリ | `./data` (server 親基準) | |
| `OSTIARIUS_SYNC_INTERVAL_MS` | passkey 同期間隔 | `900000` (15min) | |
| `OSTIARIUS_CHALLENGE_TTL_MS` | challenge TTL | `120000` (2min) | |
| `OSTIARIUS_KIOSK_TOKEN` | kiosk / enroll 画面と `/identity/*` を開く共有トークン (**secret**) | — | **必須** (P1〜) |
| `OSTIARIUS_LEGACY_METHODS` | 有効化する互換 method (CSV: `session,password`) | `''` (無効) | |
| `OSTIARIUS_STAFF_ROLES` | 職員 override を許す Cernere ロール (CSV) | `staff,teacher,admin` | |
| `OSTIARIUS_STAFF_USER_IDS` | export に `roles` が無い間の職員 userId (CSV、暫定) | `''` | |
| `OSTIARIUS_STAFF_OVERRIDE_DAILY_MAX` | 職員 1 人あたり override 日次上限 | `20` | |
| `OSTIARIUS_FACE_SIDECAR_URL` | face-sidecar ベース URL (localhost 固定推奨) | `http://127.0.0.1:17591` | 顔有効時 |
| `OSTIARIUS_TEMPLATE_KEY` | 顔テンプレートキャッシュ暗号鍵 32byte base64 (**secret**) | — | 顔有効時 **必須** |
| `OSTIARIUS_FACE_MATCH_THRESHOLD` | 1:N 受理 cos 類似度 (glintr100) | `0.62` | |
| `OSTIARIUS_FACE_MARGIN` | top1 − top2 の下限 | `0.08` | |
| `OSTIARIUS_FACE_CHALLENGE` | アクティブチャレンジ `required` / `off` | `required` | |
| `OSTIARIUS_LIVENESS_THRESHOLD` | パッシブ生体性スコア下限 | `0.90` | |
| `OSTIARIUS_FACE_TEMPLATE_SOURCE` | `cernere` (export 同期) / `local` (P3 未完時) | `cernere` | |
| `OSTIARIUS_EVENT_RETENTION_DAYS` | 監査ログ保持日数 | `90` | |
| `CERNERE_FRONTEND_URL` | 生徒向けパスキー登録 QR の URL 元 (`/profile#passkey`) | `CERNERE_BASE_URL` | |
| `AEDILIS_GATEWAY_TOKEN` | kiosk 直接送信 (`/api/checkin/gateway-verify`) の Bearer (**secret**、P3〜) | — | 顔有効時 |

顔認証 / パスキー代替 / 職員 override の設計は [feature/identity-verification.md](../feature/identity-verification.md)。

派生: `dbPath = {dataDir}/ostiarius.db`。

### ACME (TLS 証明書 CLI 専用)

server 本体では読まず、`npm run tls:issue` / `tls:renew` だけが使う
([feature/lan-tls-certificate.md](../feature/lan-tls-certificate.md))。
空文字 / 空白のみは「未設定」と同じ扱い。

| key | 役割 | 既定 | 必須 |
|---|---|---|---|
| `CLOUDFLARE_DNS_API_TOKEN` | DNS-01 の TXT 操作用 token (**secret**) | — | **必須** |
| `OSTIARIUS_ACME_EMAIL` | ACME account の連絡先 | — | **必須** |
| `OSTIARIUS_LAN_HOSTNAME` | 証明書の FQDN (zone は末尾 2 ラベル) | — | **必須** |
| `OSTIARIUS_ACME_DIRECTORY` | `production` / `staging` / 任意の directory URL | `production` | |
| `OSTIARIUS_ACME_OUTPUT_DIR` | PEM 出力先 (gitignore 済み) | `data/acme` | |
| `OSTIARIUS_ACME_ACCOUNT_KEY_PATH` | ACME account key (**secret**、無ければ生成) | `data/acme/account.key` | |
| `OSTIARIUS_ACME_RENEW_BEFORE_DAYS` | 失効の何日前から更新するか | `30` | |

> `OSTIARIUS_PRIVATE_KEY` は config 上は default 空 (空なら file 経路にフォールバック)
> だが、`env-cli.config.ts` の `required.production` に含まれており **本番では必須**
> (平文ファイルを使わない、[setup/secrets.md](./secrets.md))。

### env の供給経路

`dev` / `start` は `tsx --env-file-if-exists=.env.secrets --env-file-if-exists=.env`
で起動するため、`.env.secrets` → `.env` → host env のいずれでも設定できる
(secret は `.env.secrets` か host env、平文 `.env` に置かない)。

## ローカル起動

```bash
npm install
npm run typecheck   # 型チェック (緑であること)

# env を .env / .env.secrets / host env で設定してから:
npm run dev         # tsx watch
# または
npm start
```

> dev server の起動はこのリポの運用方針上 AI 側では行わない。手元で起動する。

起動ログで確認できる項目: listen address、`lanId` / `facilityId`、`rpId` / `pwaOrigin`、
`cernere=`、`key source=env|file|generated`、`credentials cached: N`、
自己登録 or 手動 provision の PEM。

## 関連

- secret 供給 (Infisical): [setup/secrets.md](./secrets.md)
- env の意味: [interface/http-checkin.md](../interface/http-checkin.md) / [feature/checkin-verification.md](../feature/checkin-verification.md)
- フルスタック E2E 手順: `docs/E2E-checkin.md` (§B runbook)
