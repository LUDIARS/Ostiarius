# setup: secret 供給 (Infisical / env-cli) とデプロイ

secret を平文保存しない方針 ([[feedback_config_and_secrets]])。設定は
`env-cli.config.ts` (`Cernere/packages/env-cli`)。Aedilis / Memoria / Cernere /
Bibliotheca と同パターン。

## secret 一覧 (平文保存しない)

| key | 用途 | 供給 |
|---|---|---|
| `CERNERE_SERVICE_TOKEN` | Cernere passkey export 用 admin Bearer | Infisical |
| `OSTIARIUS_PRIVATE_KEY` | Ed25519 秘密鍵 (PKCS#8 PEM)。本番はこれを inject | Infisical |
| `AEDILIS_ADMIN_TOKEN` | 公開鍵 自己登録の admin Bearer | Infisical |
| `CLOUDFLARE_DNS_API_TOKEN` | ACME DNS-01 の TXT 操作 (CLI 専用) | Infisical |
| `OSTIARIUS_KIOSK_TOKEN` | kiosk / enroll 画面と `/identity/*` の共有トークン | Infisical |
| `OSTIARIUS_TEMPLATE_KEY` | 顔テンプレートキャッシュの AES-256-GCM 鍵 (32byte base64)。Cernere export の施設配布鍵と同一 | Infisical |
| `AEDILIS_GATEWAY_TOKEN` | kiosk 直接送信 (`/api/checkin/gateway-verify`) の Bearer (P3〜) | Infisical |

これらは `env-cli.config.ts` の `infraKeys` に default を置かず、必ず Infisical から供給する。

## env-cli の設定値

- `name: "Ostiarius"`、`secretsPath: ".env.secrets"`、`dotenvPath: ".env"`。
- `defaultSiteUrl: "https://infisical.vtn-game.com"`、`defaultEnvironment: "dev"`。
- `required.production`: `OSTIARIUS_LAN_ID` / `OSTIARIUS_FACILITY_ID` / `CERNERE_BASE_URL`
  / `CERNERE_SERVICE_TOKEN` / `OSTIARIUS_RP_ID` / `OSTIARIUS_PWA_ORIGIN` /
  `OSTIARIUS_PRIVATE_KEY` (本番は秘密鍵を inject、平文ファイルを使わない)。

## 取得 / inject

```bash
# INFISICAL_* (machine identity) を .env.secrets に保存するセットアップ
npx env-cli setup

# 起動時に Infisical から fetch + inject (Aedilis / Memoria / Cernere と同パターン)
npx env-cli
```

`INFISICAL_*` は `.env.secrets` に保存され、アプリの infra/secret 値は Infisical 側に置く。

## 秘密鍵 (Ed25519) の供給 2 経路

- **本番**: `OSTIARIUS_PRIVATE_KEY` を Infisical / secret-agent で inject。env に PEM が
  あれば最優先 (`key source=env`)、平文ファイルを置かない。
- **dev**: env 未設定なら `OSTIARIUS_KEY_PATH` の平文 PKCS#8 PEM (無ければ生成、
  `0600` best-effort)。`key source=file|generated`。dev 専用。

## デプロイ前提 (会場 LAN ゲートウェイ)

- 会場 PC / Raspberry Pi に置き、来場者端末とは別サブネット (会場 LAN) で接続する。
  loopback では「会場にいること」の検証性質が成立しない。
- Ostiarius と Aedilis の時刻を NTP 同期する (attestation の `issuedAt` を Aedilis が
  120 秒以内で照合するため)。
- Ostiarius・PWA・Cernere の origin / RP ID は同一 eTLD+1 に揃える (WebAuthn 制約)。

> 物理 E2E の通し手順は `docs/E2E-checkin.md` §B (runbook) を参照。

## TLS 証明書 (ACME DNS-01)

`npm run tls:issue` / `tls:renew` は `data/acme/` に PEM を書くだけで Infisical を更新しない。
発行後に `OSTIARIUS_TLS_CERTIFICATE_PEM` / `OSTIARIUS_TLS_PRIVATE_KEY_PEM` /
`OSTIARIUS_TLS_MODE` を運用者が Infisical に登録する。`data/acme/` (秘密鍵・account key) は
gitignore 済みで、リポジトリには入れない。Cloudflare token は `--token` で argv に渡さず
env (`CLOUDFLARE_DNS_API_TOKEN`) で供給する (プロセス一覧・履歴に残るため)。
詳細: [feature/lan-tls-certificate.md](../feature/lan-tls-certificate.md)。

## 関連

- env 一覧: [setup/configuration.md](./configuration.md)
- 鍵管理: [feature/attestation-key-management.md](../feature/attestation-key-management.md)
- TLS 証明書: [feature/lan-tls-certificate.md](../feature/lan-tls-certificate.md)
