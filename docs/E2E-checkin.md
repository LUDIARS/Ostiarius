# 出席チェックイン E2E 結合確認 (runbook)

Cernere + Ostiarius + Aedilis + PWA の 4 者と「生体タップ」を通した出席
チェックインの **E2E 結合確認** 手順。 各コンポーネント単体は緑でも、 跨りの
結合は環境 (別 PC / 会場 LAN / 実機 passkey) が要るため別建てで確認する。

正本仕様は `Aedilis/checkin-spike/CONTRACTS.md`。

```
[PWA (Aedilis配信)] ──(LAN)──> [Ostiarius] ──attestation──> PWA ──(WAN)──> [Aedilis cloud]
        │                          ▲
        └ Cernere SSO(passkey)     └ Cernere passkey export (初回/定期 sync)
```

確認は 2 層に分ける:

| 層 | 何を見るか | 実機/インフラ | 実行 |
|----|-----------|--------------|------|
| **A. 自動** | assertion → attestation 発行レッグ + 跨りサービスの attestation 検証契約 | 不要 (loopback + ソフト authenticator) | `npm test` |
| **B. フルスタック手動** | Cernere 同期 → 実機生体タップ → Aedilis 出席記録 までの通し | **必要** (別 PC / 会場 LAN / 実機 passkey / NTP) | 本書 §B の手順 |

---

## A. 自動 E2E (実機なし)

`test/checkin.e2e.test.ts` が、 `test/webauthn-soft-authenticator.ts` の
ソフトウェア WebAuthn authenticator (ES256/P-256) を「生体タップ」の代替として
使い、 Ostiarius の本体フローを in-process で通す。

```bash
npm test
```

カバー範囲:

- `POST /checkin/begin` → UV 付き assertion 署名 → `POST /checkin/finish` →
  Ed25519 attestation 発行 (happy path)。
- 発行 attestation が **Aedilis と同一の Ed25519/SPKI 契約** (CONTRACTS §1) で
  検証でき、 `sub` / `lanId` / `placeId` / `nonce` が期待どおりであること。
- 異常系: credential 未同期で begin 409 / 未登録 credential 401 /
  challenge replay (2 度目 400) / 未発行 challenge 400 / 署名改竄 401 /
  origin・rpId 不一致 401。

**ソフト authenticator が代替できない部分** (= §B で確認):
プラットフォーム authenticator の OS 統合 (Windows Hello / Touch ID 等の実 UV)、
会場 LAN のネットワーク分離、 Cernere からの公開鍵同期、 Aedilis 認証
(Cernere PASETO) を伴う実 HTTP 経路。

Aedilis 側 (attestation 受領 → 出席記録 → 予約照合 → replay) の自動確認は
`Aedilis` リポの `npm test` (`test/checkin.test.ts`) を参照。

---

## B. フルスタック手動 E2E

### B-0. 前提 (物理要件)

- **別 PC / Raspberry Pi** に Ostiarius を置き、 来場者端末とは **別サブネット**
  (会場 LAN) で接続する。 loopback では「会場にいること」の検証性質を確認できない。
- 来場者端末に **実機 passkey** (Windows Hello / Touch ID / セキュリティキー等) を
  Cernere に登録済みであること。
- Cernere / Ostiarius / PWA の **origin・RP ID は同一 eTLD+1** に揃える
  (WebAuthn 仕様要件)。 ローカル検証は `localhost` で揃えるか、 hosts /
  リバースプロキシで `*.example.test` 等を用意する。
- Ostiarius と Aedilis の **時刻を NTP 同期** する (attestation の `issuedAt` を
  120 秒以内で照合するため)。

### B-1. Cernere を起動 (Postgres / Redis / secrets)

```bash
cd Cernere
npm run env:up:standalone   # PG + Redis + secrets を含む all-in-one
# OIDC/passkey に必要な env (WEBAUTHN_RP_ID / WEBAUTHN_ORIGINS) を環境に合わせて設定
# 既定 listen: 8080
curl -s http://localhost:8080/api/auth/passkey/export -H "Authorization: Bearer <service token>" | jq .
```

- ブラウザで Cernere にログインし、 **passkey を登録** (実機生体)。
- `GET /api/auth/passkey/export` (admin/service Bearer) に登録した公開鍵が
  出ることを確認する。

### B-2. Aedilis を起動 (cloud 側)

```bash
cd Aedilis
npm run dev                 # 既定 listen: 17502 (AEDILIS_PORT)
```

- admin で **予約を作成**: `POST /api/reservations`
  (`{ facilityId, startAt, endAt }`、 Cernere Bearer)。
- `facilityId` は Ostiarius の `OSTIARIUS_FACILITY_ID` と一致させる。

### B-3. Ostiarius を起動 (会場 LAN ゲートウェイ)

会場 PC / Pi で、 来場者端末から届く LAN アドレスで listen させる。

```bash
cd Ostiarius
export OSTIARIUS_LAN_ID=venue-1
export OSTIARIUS_FACILITY_ID=room-101         # Aedilis の予約 facilityId と一致
export CERNERE_BASE_URL=http://<cernere-host>:8080
export CERNERE_PROJECT_CLIENT_ID=<project client id>
export CERNERE_PROJECT_CLIENT_SECRET=<project client secret>  # passkey export 用Bearerを都度取得
# 手動の一時確認だけは CERNERE_SERVICE_TOKEN=<fixed service token> でもよい
export OSTIARIUS_RP_ID=<Cernere と同 eTLD+1>
export OSTIARIUS_PWA_ORIGIN=https://<Aedilis PWA origin>
# 公開鍵の自己登録 (任意、 両方そろえば Aedilis の gateway_registry に自動登録)
export AEDILIS_BASE_URL=http://<aedilis-host>:17502
export AEDILIS_ADMIN_TOKEN=<aedilis admin Bearer>
npm start                                     # 既定 listen: 17590
```

確認:

- 起動ログに `credentials cached: N` (>0) — Cernere export 同期が成功している。
- `curl http://<ostiarius-lan>:17590/api/health` が `credentials > 0` を返す。
- 自己登録しない場合は、 起動ログの gateway public key (PEM) を Aedilis の
  `POST /api/admin/gateways` (`{ lanId, publicKeyPem, facilityId, label }`) に
  手動登録する。 `GET /api/admin/gateways` に出ることを確認。

### B-4. 来場者端末で check-in (実機生体タップ)

1. 来場者端末で Aedilis 配信の PWA (`/checkin.html`) を開く。
2. PWA に会場ゲートウェイ URL (`http://<ostiarius-lan>:17590`) を指定 (QR 等)。
3. PWA → `POST {gateway}/checkin/begin` で nonce 取得。
4. **Cernere SSO で passkey 認証 (実機生体タップ)** → assertion 取得。
5. PWA → `POST {gateway}/checkin/finish` → Ostiarius が assertion を
   オフライン検証 → attestation を返す。
6. PWA → Aedilis `POST /api/checkin/verify`(`{ attestation }` + Cernere Bearer)。

### B-5. 検証チェックリスト

| # | 確認項目 | 期待 |
|---|----------|------|
| 1 | `/checkin/finish` 応答 | `{ ok: true, attestation }` |
| 2 | Aedilis `/api/checkin/verify` 応答 | `{ ok, attendanceId, matchedReservation }` |
| 3 | 予約照合 | B-2 の予約に一致 → `matchedReservation` が予約 ID |
| 4 | 出席記録 | Aedilis `GET /api/checkin/mine` に当該出席が出る |
| 5 | replay 拒否 | 同一 attestation を再送 → 409 (nonce UNIQUE) |
| 6 | 古い attestation 拒否 | `issuedAt` が 120 秒超 → 拒否 |
| 7 | 別人 attestation 拒否 | `sub` ≠ 認証ユーザ → 拒否 |
| 8 | 自宅から不可 | 会場 LAN 外から `/checkin/*` に到達しない (ネットワーク分離) |
| 9 | webhook | `MEMORIA_WEBHOOK_URL` 設定時、 `attendance.checked_in` が中継へ届く |

> #5–#7 は Aedilis 単体テスト (`Aedilis/test/checkin.test.ts`) でも自動確認済み。
> #1 と assertion 検証は本リポの自動 E2E (§A) で確認済み。 §B では **実機生体 +
> 実ネットワーク** での通し成立を最終確認する。

### B-6. 後片付け

- 検証用に発行した `AEDILIS_ADMIN_TOKEN` / `CERNERE_SERVICE_TOKEN` を失効し、
  使用した `CERNERE_PROJECT_CLIENT_SECRET` を安全に破棄する。
- 検証用の予約 / 出席 / gateway 登録をクリーンアップ。
