---
task: idv-p1-passkey
project: Ostiarius
kind: 実装
status: planned
created: 2026-08-16T00:00:00.000Z
delegation_run_id: null
memoria_task_id: 1048
actio_task_id: null
memory_links: []
---
# P1: パスキー代替経路 + kiosk 導線 + attestation `method/assurance` 拡張

## 目的

顔認証 (P2) に先立ち、初日から使えるパスキー経路を kiosk 導線込みで整え、attestation に
`method` / `assurance` を付ける。設計正本: [feature/passkey-fallback.md](../feature/passkey-fallback.md)、
[feature/identity-verification.md](../feature/identity-verification.md) §4 §6、
[interface/http-identity.md](../interface/http-identity.md)。

## 完了条件

- [ ] `signAttestation` payload に `method` / `assurance` を末尾追加 (順序固定)。既存 5 フィールドの互換テストが通る。
- [ ] `/identity/session` (POST/GET) の kiosk セッション store (TTL 60s、in-memory) を実装。
- [ ] `/identity/passkey/begin|finish` を既存 `/checkin/begin|finish` と同一ロジックでマウント (共通関数へ抽出、旧パスは互換維持)。finish で `method=passkey`、`assurance=medium`、`sessionId` 紐づけで `state=issued`。
- [ ] `GET /identity/passkey/register-hint`: `{CERNERE_FRONTEND_URL}/profile#passkey` の URL + QR (SVG) を返す (Cernere API は呼ばない。device-link は step-up proof 必須なので kiosk では扱わない)。env `CERNERE_FRONTEND_URL` を config に追加。
- [ ] `/kiosk` 静的画面 (Ostiarius 配信、`OSTIARIUS_KIOSK_TOKEN` 必須): 「パスキーで出席」→ 生徒端末用 QR (`{OSTIARIUS_PWA_ORIGIN}/checkin?nonce=`) と「端末を登録」→ register-hint の QR。完了をポーリングで表示。顔認証ボタンは P2 まで無効表示。
- [ ] `session` / `password` (#5 #6) を `OSTIARIUS_LEGACY_METHODS` で既定無効化、有効時は `method` / `assurance=low` を付与。
- [ ] `verification_events` テーブル (data/face-templates.md) を追加し、passkey/legacy の issued を記録 (画像なし)。
- [ ] `/api/health` に `methods` (有効な method 一覧) を追加。
- [ ] spec: `interface/http-checkin.md` に `/identity/passkey/*` へのリンクと `method` 追加を反映。README の役割説明を更新。
- [ ] `npm run typecheck` / `npm test` 成功。vitest でセッション遷移・attestation 拡張・legacy 無効化をカバー。
- [ ] 1 PR (Revisor local PR、base main)。

## スコープ外
- 顔認証・sidecar (P2)、Cernere/Aedilis 側の変更 (P3)。`roles` は `OSTIARIUS_STAFF_USER_IDS` 暫定でよい。
