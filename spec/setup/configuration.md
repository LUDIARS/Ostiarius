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

派生: `dbPath = {dataDir}/ostiarius.db`。

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
