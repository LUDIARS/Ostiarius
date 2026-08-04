# test: テスト種別と担保内容

Ostiarius のテスト設計と現状。サービス種別は「会場 LAN 上の検証ゲートウェイ
(認証・署名を扱う API)」であり、**検証ロジックの正しさ**と**跨りサービスの attestation
検証契約**が一番守るべき不変条件。

実行: `npm run typecheck` + `npm test` (`vitest run`)。CI は `.github/workflows/test.yml`。

## 現状サマリ (正直版)

| 種別 | 状態 | 実体 |
|---|---|---|
| ビルド / 型チェック | **あり** | `tsc --noEmit` (CI ゲート) |
| 自動 E2E (in-process) | **あり** | `test/checkin.e2e.test.ts` (vitest 8 ケース) |
| ソフト authenticator | **あり** | `test/webauthn-soft-authenticator.ts` (生体タップ代替) |
| 依存監査 | **あり** | `npm audit --omit=dev --audit-level=high` (CI ゲート) |
| モジュール単体 unit | **一部** | ACME のみ有り (`test/acme-*.test.ts`)。challenge-store / attestation / cernere-sync / config は未整備 |
| ライブ統合 (実 HTTP) | **無し** | Cernere 同期 / Aedilis 自己登録 / ACME 実発行 (Let's Encrypt + Cloudflare) の実 HTTP 経路は自動化されていない |
| 物理 E2E (実機/会場 LAN) | **手動のみ** | `docs/E2E-checkin.md` §B runbook (AI 実行不能) |

## 1. ビルドチェック / 型 (あり)

- `npm run typecheck` = `tsc --noEmit -p tsconfig.json`。`server/**` + `test/**` を対象、
  `strict` + `noUncheckedIndexedAccess` 等で型安全を担保。
- CI の必須ステップ。

## 2. 自動 E2E (あり) — `test/checkin.e2e.test.ts`

Hono `app.request` で in-process に検証フローを通す。`test/webauthn-soft-authenticator.ts`
(ES256/P-256 のソフト WebAuthn authenticator) が「生体タップ」を代替する。実機・別 PC・
LAN 不要。担保しているケース:

- **happy path**: begin → UV 付き assertion 署名 → finish → Ed25519 attestation 発行。
  発行 attestation が **Aedilis と同一の Ed25519/SPKI 契約** (CONTRACTS §1) で検証でき、
  `sub` / `lanId` / `placeId` / `nonce` / `issuedAt` が期待どおり。
- credential 未同期 → begin 409 (`no_credentials`)。
- 未登録 credential の assertion → 401 (`unknown_credential`)。
- 同一 challenge 二度使用 → 2 度目 400 (`challenge_expired`、replay 防止)。
- begin 未発行の challenge → 400 (`challenge_expired`)。
- 署名改竄 → 401 (`assertion_failed`)。
- origin / rpId 不一致 → 401 (`assertion_failed`)。
- `GET /gateway-public-key` が `lanId` / `facilityId` / 公開鍵 PEM を返す。

> これが一番重要な担保。検証境界 (offline 検証 → attestation) と異常系を網羅している。

## 3. ソフト authenticator が代替できない部分

実 OS 統合 (Windows Hello / Touch ID の実 UV)、会場 LAN のネットワーク分離、Cernere
からの実公開鍵同期、Aedilis 認証 (Cernere PASETO) を伴う実 HTTP — これらは §B 手動
runbook で確認する。

## 4. CI (`.github/workflows/test.yml`)

push / PR (main) で `ci-check` ジョブ: `npm ci` → `npm run typecheck` → `npm test`
→ `npm audit --omit=dev --audit-level=high`。Node 24.14.1。

## 5. 物理 E2E (手動 runbook のみ)

`docs/E2E-checkin.md` §B。別 PC / 会場 LAN / 実機 passkey / NTP が要るため自動化対象外
(AI 実行不能)。Cernere 同期 → 実機生体タップ → Aedilis 出席記録までの通しと、replay /
古い attestation / 別人 / ネットワーク分離 を運用者が確認する。

## やること (担保を厚くするなら)

- **モジュール単体 unit** を足す: `ChallengeStore` の TTL/consume/sweep、
  `attestation.ts` の sign↔verify ラウンドトリップ + 改竄検出、`config.ts` の必須欠落で
  exit、`cernere-sync.ts` の不正行 skip / best-effort フォールバック。現状これらは E2E
  経由で間接的にしか触れていない (fake-dep でなく実経路で検証する、
  [[feedback_fake_dep_tests_miss_real_sql]])。
- **`cernere-sync` / `aedilis-register` の実 HTTP** をローカル stub サーバで自動結合する
  (現状は in-process E2E が直接 `upsertCredential` して同期済み状態を再現しており、
  fetch 経路自体は自動テストで触れていない)。
- §B runbook の **runner グリーン化** (All-In-OneTest 連携、実機物理 E2E は AI 実行不能)。

## 関連

- 自動 E2E が通す機能: [feature/checkin-verification.md](../feature/checkin-verification.md)
- runbook: `docs/E2E-checkin.md`
