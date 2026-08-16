# feature: チェックイン検証 (offline passkey assertion → attestation 発行)

Ostiarius の中核機能。会場 LAN の PWA から来た passkey assertion を、事前同期した
公開鍵だけで**オフライン検証**し、OK なら presence-attestation を Ed25519 で署名して返す。

- 実装: `server/routes/checkin.ts`、`server/challenge-store.ts`、`server/attestation.ts`
- 接点定義: [interface/http-checkin.md](../interface/http-checkin.md)

## 目的 / ユーザーストーリー

来場者が「いま会場にいる」ことを証明したい。会場 LAN にしか到達できない
ゲートウェイで assertion を検証することで、自宅からの偽装を防ぐ。そのため Cernere
に都度問い合わせず、**事前同期した公開鍵だけ**で検証する (offline verification)。

- アクター: 来場者 (PWA 経由)、運用者 (gateway 設置)。
- 提供物: 検証 OK の証跡 = Aedilis が検証できる attestation トークン。

## 振る舞い (入力 → 処理 → 出力)

2 ステップ。

### 1. `POST /checkin/begin` — nonce 発行

1. `challenges.sweep()` で失効 challenge を掃除。
2. `listCredentials(db)` で同期済み全件を取得。0 件なら `409 no_credentials`。
3. `generateAuthenticationOptions`（`@simplewebauthn/server`）を
   `rpID = rpId` / `userVerification: 'required'` / `allowCredentials =` 全 credential
   (`id`, `transports`) で生成 (usernameless 風)。
4. 生成された `options.challenge` を `ChallengeStore` に TTL 2min で保存。
5. options を返す。

### 2. `POST /checkin/finish` — 検証 + 署名

入力: `{ response: AuthenticationResponseJSON }`。

1. `response` / `response.id` が無ければ `400 bad_request`。
2. `getCredential(db, response.id)` で credential を引く。無ければ `401 unknown_credential`。
3. `response.response.clientDataJSON` (base64url) を decode し JSON の `challenge` を取り出す。
   失敗で `400 bad_request (clientDataJSON invalid)`。
4. `challenges.consume(challenge)`。未保存 / 失効 / 二度目 (consume 済み) なら
   `400 challenge_expired` (TTL + **replay 防止**を 1-shot consume で兼ねる)。
5. `verifyAuthenticationResponse` を
   `expectedChallenge / expectedOrigin = pwaOrigin / expectedRPID = rpId /
   requireUserVerification: true / credential(publicKey, counter, transports)` で実行。
   例外 or `verified=false` なら `401 assertion_failed`。
6. counter は best-effort: `newCounter < stored` は warn のみ (clone 警戒、hard fail しない)。
   `newCounter > stored` なら `updateCredentialCounter` で前進。
7. `signAttestation({ sub: user_id, placeId: facilityId, lanId, nonce: challenge,
   issuedAt: Date.now() })` を gateway 秘密鍵で署名。
8. `{ ok: true, attestation }` を返す。

## 状態遷移 (challenge)

```
[begin] put(challenge) ──TTL 2min──> [失効] (consume で false)
   └────── finish: consume(challenge) ── 成功で 1-shot 削除 ──> 再利用不可 (replay 拒否)
```

`ChallengeStore` (`server/challenge-store.ts`) は in-memory Map (key = challenge 値)。
単一ゲートウェイ前提で再起動時に消えてよい。`sweep()` は begin の度に呼ぶ。

## attestation の形式

`base64url(JSON payload) + "." + base64url(Ed25519 署名)` (`server/attestation.ts`、
CONTRACTS §1 / spike `shared.ts` と完全一致)。payload は固定フィールド・順序:

| field | 値 | 意味 |
|---|---|---|
| `sub` | `credentials.user_id` | assertion で確定した本人 (Cernere user id) |
| `placeId` | `OSTIARIUS_FACILITY_ID` | 出席対象の施設/部屋 |
| `lanId` | `OSTIARIUS_LAN_ID` | 発行ゲートウェイ ID (Aedilis が公開鍵を引くキー) |
| `nonce` | 消費した challenge | replay 検出用 |
| `issuedAt` | `Date.now()` (epoch ms) | 出席時刻の正本 (ゲートウェイ時計) |

署名は `crypto.sign(null, body, ed25519PrivateKey)`。検証側 (Aedilis) は `lanId` で
引いた SPKI 公開鍵で `crypto.verify`。形式を変えると Aedilis の検証が破綻する。

## 制約 / 前提 / 既知の制限

- **offline**: Cernere に都度問い合わせない。検証は同期済み公開鍵のみ。0 件だと begin が 409。
- **origin / RP ID の一致**: PWA origin (`OSTIARIUS_PWA_ORIGIN`) と RP ID
  (`OSTIARIUS_RP_ID`) が assertion と一致しないと `verifyAuthenticationResponse` が失敗。
  Ostiarius・PWA・Cernere は同一 eTLD+1 に揃える (WebAuthn 制約)。
- **counter は best-effort**: passkey は counter=0 固定が多く、後退は warn のみ。
- **時刻依存**: `issuedAt` はゲートウェイ時計。Aedilis 側は 120 秒で照合するため
  両者の NTP 同期が前提 (Ostiarius 自身はチェックしない)。
- **ネットワーク分離は Ostiarius の責務外**: 「会場 LAN 外から届かない」性質は
  デプロイ (会場 LAN 配置) が担保する。アプリは検証ロジックのみ。

## 関連

- 公開鍵キャッシュ: [data/credentials.md](../data/credentials.md)
- 役割再設計 (顔認証が主経路、パスキーは補助): [feature/identity-verification.md](./identity-verification.md) / [feature/passkey-fallback.md](./passkey-fallback.md)
- HTTP contract: [interface/http-checkin.md](../interface/http-checkin.md)
- 鍵供給: [feature/attestation-key-management.md](./attestation-key-management.md)
