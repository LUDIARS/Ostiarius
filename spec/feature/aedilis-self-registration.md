# feature: Aedilis への公開鍵 自己登録 (#167)

ゲートウェイ公開鍵を Aedilis の `gateway_registry` に自動登録する機能。手動 provision の
省力化であり、フォールバックとして手動経路も残す。

- 実装: `server/aedilis-register.ts`、判断は `server/index.ts` `provisionGatewayKey()`
- 連携先 contract: [interface/aedilis-gateway-registry.md](../interface/aedilis-gateway-registry.md)

## 目的

attestation の検証鍵として、ゲートウェイ公開鍵を Aedilis に登録する。これがないと
Aedilis は `lanId` から公開鍵を引けず attestation を検証できない。

## 起動時の分岐 (`provisionGatewayKey`)

- `AEDILIS_BASE_URL` と `AEDILIS_ADMIN_TOKEN` が **両方** あれば → 自己登録 (推奨)。
- どちらか欠ければ → **手動 provision フォールバック**: 起動ログに公開鍵 PEM を出し、
  運用者が Aedilis の `POST /api/admin/gateways` に登録する。

## 自己登録の振る舞い (`registerGatewayKey`)

- `POST {AEDILIS_BASE_URL}/api/admin/gateways` に `Bearer {AEDILIS_ADMIN_TOKEN}` +
  body `{ lanId, publicKeyPem, facilityId, label }` を送る。
- 2xx → 成功 (`true`)。
- **4xx** → 設定/権限ミスとみなし**即諦め** (`false`)、手動 provision に切替を促す
  (リトライしても直らない)。
- **5xx / ネット不通** → warn しつつ最大 `maxAttempts` 回 (既定 4) を `retryDelayMs`
  (既定 5000ms) 間隔でリトライ。全失敗で `false`。
- 例外は内部で握りつぶし、**起動シーケンスをブロックしない** (`void` 呼び)。

## SRP

`aedilis-register.ts` は HTTP 登録だけに責務を絞る。「やるか否か (env 揃い)」の判断は
呼び出し側 (`index.ts`) が持つ。

## 制約 / 前提

- `AEDILIS_BASE_URL` は末尾スラッシュ除去済み (`config.ts`)。
- `AEDILIS_ADMIN_TOKEN` は admin Cernere Bearer。secret 扱い ([setup/secrets.md](../setup/secrets.md))。
- `label` は空でも送る (`OSTIARIUS_LABEL` 既定空)。

## 関連

- 登録 contract: [interface/aedilis-gateway-registry.md](../interface/aedilis-gateway-registry.md)
- 鍵管理: [feature/attestation-key-management.md](./attestation-key-management.md)
