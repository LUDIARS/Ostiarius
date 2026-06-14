# Ostiarius — 会場LANチェックインゲートウェイ

LUDIARS の出席チェックイン基盤の「会場側」コンポーネント。会場の LAN に置く
小さなスタンドアロンサービス (Raspberry Pi / 会場 PC 等) で、来場者の PWA から
来た passkey assertion を **オフラインで** 検証し、検証 OK なら出席の証跡
(attestation) を自鍵で署名して返す。

正本仕様は `Aedilis/checkin-spike/CONTRACTS.md` (§1 Attestation / §3 Ostiarius)。
スパイク `gateway-server.ts` を「本物のサービス」に昇格させたもの。

```
[PWA (Aedilis配信)] ──(LAN)──> [Ostiarius] ──attestation──> PWA ──(WAN)──> [Aedilis cloud]
        │                          ▲
        └ Cernere SSO(passkey)     └ Cernere passkey export (初回/定期 sync)
```

## なぜオフライン検証か

来場者が「いま会場にいる」ことを示すのが目的。会場 LAN にしか到達できない
ゲートウェイで passkey assertion を検証することで、自宅から偽装できないように
する。そのため Cernere に都度問い合わせず、**事前に同期した公開鍵だけ**で
assertion を検証する。

## アーキ

- Hono + @hono/node-server + better-sqlite3 + tsx (Aedilis / Bibliotheca pattern)
- `@simplewebauthn/server` で passkey assertion を検証 (Cernere と同じ使い方)
- attestation は Ed25519 署名。形式は CONTRACTS §1 / spike `shared.ts` と完全一致
  (`base64url(JSON payload) + "." + base64url(署名)`) なので Aedilis が検証できる

### ファイル構成

| パス | 役割 |
|---|---|
| `server/index.ts` | 起動 (Hono / CORS / sync 開始 / route mount / listen) |
| `server/config.ts` | env 解決 (必須は未設定で exit、port 等は default 容認) |
| `server/db.ts` | better-sqlite3 + `credentials` テーブル (公開鍵キャッシュ) |
| `server/cernere-sync.ts` | Cernere passkey export の起動時 + 定期同期 |
| `server/attestation-key.ts` | Ed25519 鍵の load/create (永続) |
| `server/attestation.ts` | attestation の sign/verify (CONTRACTS §1 と同形式) |
| `server/challenge-store.ts` | challenge の TTL 2min in-memory ストア |
| `server/routes/checkin.ts` | `/checkin/begin` `/checkin/finish` `/gateway-public-key` |

## config (env)

| key | 役割 | 既定 |
|---|---|---|
| `OSTIARIUS_PORT` | listen port | `17590` |
| `OSTIARIUS_LAN_ID` | このゲートウェイの ID (attestation.lanId) | **必須** |
| `OSTIARIUS_FACILITY_ID` | 紐づく施設 (attestation.placeId) | **必須** |
| `CERNERE_BASE_URL` | passkey export の取得元 | **必須** |
| `CERNERE_SERVICE_TOKEN` | export 用 admin/service Bearer | **必須** |
| `OSTIARIUS_RP_ID` | WebAuthn rpID (Cernere と同 eTLD+1) | **必須** |
| `OSTIARIUS_PWA_ORIGIN` | CORS 許可 + expectedOrigin の PWA origin | **必須** |
| `OSTIARIUS_KEY_PATH` | Ed25519 秘密鍵の永続パス (無ければ生成) | `data/gateway.key` |
| `OSTIARIUS_DATA` | data ディレクトリ | `./data` |
| `OSTIARIUS_SYNC_INTERVAL_MS` | passkey 同期間隔 | `900000` (15min) |
| `OSTIARIUS_CHALLENGE_TTL_MS` | challenge TTL | `120000` (2min) |

> **RP ID / origin の前提**: Ostiarius・PWA・Cernere の origin / RPID は
> **同一 eTLD+1** に揃える必要がある (WebAuthn の制約)。`OSTIARIUS_RP_ID` は
> Cernere の `WEBAUTHN_RP_ID` と、`OSTIARIUS_PWA_ORIGIN` は PWA を配信する
> origin (= Cernere の `WEBAUTHN_ORIGINS` に含まれる値) と一致させること。

## API

- `POST /checkin/begin` → `generateAuthenticationOptions`。同期済み全 credential を
  `allowCredentials` に詰め、challenge を TTL 2min で保存。返り = options。
- `POST /checkin/finish` body `{ response }` → assertion を同期済み公開鍵で検証
  → OK なら credentialId から userId を引き、attestation を署名して
  `{ ok, attestation }` を返す。
- `GET /gateway-public-key` → `{ lanId, facilityId, publicKeyPem }` (初回 provision 用)。
- `GET /api/health` → `{ ok, service, lanId, facilityId, credentials }`。

## 起動手順

```bash
npm install
npm run typecheck   # 型チェック (緑であること)

# 環境変数を .env / .env.secrets / host env のいずれかで設定してから:
npm run dev         # tsx watch
# または
npm start
```

> dev server の起動はこのリポの運用方針上 AI 側では行わない。手元で起動する。

## 運用: Aedilis への公開鍵登録

1. Ostiarius を一度起動すると、`OSTIARIUS_KEY_PATH` に Ed25519 秘密鍵が生成され、
   **公開鍵 PEM が起動ログ**に出力される (`GET /gateway-public-key` でも取得可)。
2. その PEM を Aedilis の admin API に登録する:

   ```bash
   curl -X POST {AEDILIS}/api/admin/gateways \
     -H "authorization: Bearer <admin Cernere token>" \
     -H "content-type: application/json" \
     -d '{
       "lanId": "<OSTIARIUS_LAN_ID>",
       "facilityId": "<OSTIARIUS_FACILITY_ID>",
       "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
       "label": "会場ゲートウェイ 1"
     }'
   ```

3. 以後 Aedilis は `POST /api/checkin/verify` で attestation を `lanId` から引いた
   この公開鍵で検証する。

## Cernere passkey export

Ostiarius は起動時 + 15min 毎に `GET {CERNERE_BASE_URL}/api/auth/passkey/export`
(Bearer `CERNERE_SERVICE_TOKEN`) を呼び、公開鍵を `credentials` テーブルへ upsert
する。ネット不通時は前回キャッシュで継続 (warn ログのみ、起動は止めない)。

## セキュリティ注記 (スパイク段階)

- Ed25519 **秘密鍵は平文 PKCS#8 PEM** でファイル保存している
  (`0600` 権限を best-effort で付与)。本来 LUDIARS は secret を平文保存しない方針
  ([[feedback_config_and_secrets]]) なので、本番化時は OS キーチェーン /
  secret-agent (`@cernere/env`) に寄せること。
- 個人データは保持しない。`credentials` テーブルは Cernere 由来の公開鍵 +
  userId アンカーのキャッシュのみ ([[project_personal_data_rule]])。
- counter は best-effort。passkey は counter=0 固定が多いため、後退検知は
  warn のみで hard fail しない。
