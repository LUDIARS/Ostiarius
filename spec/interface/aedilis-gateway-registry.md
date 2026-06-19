# interface: Aedilis gateway registry (連携先 — 公開鍵登録)

ゲートウェイ公開鍵を Aedilis の `gateway_registry` に登録する外部接点。Ostiarius は
**クライアント側**。実装: `server/aedilis-register.ts`。

## エンドポイント

- `POST {AEDILIS_BASE_URL}/api/admin/gateways`
- 認証: `Authorization: Bearer {AEDILIS_ADMIN_TOKEN}` (admin Cernere Bearer)。
- `Content-Type: application/json`。

## Ostiarius が送る body

```jsonc
{
  "lanId": "OSTIARIUS_LAN_ID",
  "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
  "facilityId": "OSTIARIUS_FACILITY_ID",
  "label": "OSTIARIUS_LABEL"   // 空文字でも送る
}
```

`publicKeyPem` は attestation 署名鍵の SPKI PEM。Aedilis はこれを `lanId` で引いて
attestation を検証する。

## レスポンスの扱い (Ostiarius 側)

| Aedilis 応答 | Ostiarius の挙動 |
|---|---|
| 2xx | 成功。登録ログを出して終了 |
| 4xx | 即諦め (設定/権限ミス)、手動 provision に切替を促す |
| 5xx / ネット不通 | warn + リトライ (既定 4 回、5000ms 間隔)、全失敗で手動フォールバック |

例外は握りつぶし、起動シーケンスをブロックしない。

## 手動 provision (フォールバック / 連携先での後続)

env が揃わない場合、運用者が起動ログ or `GET /gateway-public-key` の PEM を上記
`POST /api/admin/gateways` に手で登録する。登録後、Aedilis は
`POST /api/checkin/verify` で attestation を `lanId` から引いた公開鍵で検証する
(Aedilis 側のエンドポイント、本リポの責務外)。

## 前提

- `AEDILIS_BASE_URL` は末尾スラッシュ除去済み。
- `AEDILIS_ADMIN_TOKEN` は secret ([setup/secrets.md](../setup/secrets.md))。

## 関連

- 自己登録機能: [feature/aedilis-self-registration.md](../feature/aedilis-self-registration.md)
- 鍵管理: [feature/attestation-key-management.md](../feature/attestation-key-management.md)
