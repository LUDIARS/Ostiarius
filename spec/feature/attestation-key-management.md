# feature: attestation 署名鍵の管理 (Ed25519)

ゲートウェイが attestation を署名する Ed25519 鍵の load/create と、公開鍵の公開。

- 実装: `server/attestation-key.ts`、署名/検証は `server/attestation.ts`
- 公開: `GET /gateway-public-key` + 起動ログ ([interface/http-checkin.md](../interface/http-checkin.md))

## 目的

attestation の署名鍵を安全に供給し、対応する公開鍵 (SPKI PEM) を Aedilis の
`gateway_registry` に登録させる。Aedilis はこの公開鍵で attestation を検証する。

## 鍵供給の 2 経路 (`loadOrCreateKeyPair`)

優先順:

1. **本番 (`source = 'env'`)**: `OSTIARIUS_PRIVATE_KEY` (PKCS#8 PEM) があればこれを使う。
   Infisical / secret-agent が inject する想定。平文ファイルを置かない。
2. **dev (`source = 'file'`)**: env が無く `OSTIARIUS_KEY_PATH` のファイルが存在すれば
   それを読む。
3. **dev 初回 (`source = 'generated'`)**: ファイルも無ければ `ed25519` 鍵を生成し
   `OSTIARIUS_KEY_PATH` に PKCS#8 PEM で保存 (`mode 0600`、`chmod 0600` best-effort、
   Windows では概ね no-op)。

いずれも `asymmetricKeyType === 'ed25519'` を assert。公開鍵は秘密鍵から導出するため
別ファイルを持たない。`source` は起動ログ `key source=env|file|generated` に出る。

## 公開鍵の公開

- 起動ログに PEM を出力 (手動 provision 用)。
- `GET /gateway-public-key` で `{ lanId, facilityId, publicKeyPem }` を返す。
- `AEDILIS_BASE_URL` + `AEDILIS_ADMIN_TOKEN` が両方あれば起動時に自己登録
  ([feature/aedilis-self-registration.md](./aedilis-self-registration.md))。

## 制約 / 前提

- **鍵形式固定**: payload・署名形式を変えると Aedilis の検証が破綻する
  ([feature/checkin-verification.md](./checkin-verification.md) の attestation 形式)。
- 秘密鍵は secret。本番は env inject、平文ファイルは dev 専用
  ([[feedback_config_and_secrets]])。

## 関連

- secret 供給: [setup/secrets.md](../setup/secrets.md)
- 自己登録: [feature/aedilis-self-registration.md](./aedilis-self-registration.md)
