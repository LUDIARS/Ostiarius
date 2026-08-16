---
task: idv-p3-cernere-aedilis
project: Ostiarius
kind: 実装
status: planned
created: 2026-08-16T00:00:00.000Z
delegation_run_id: null
memoria_task_id: 1048
actio_task_id: null
memory_links: []
---
# P3: Cernere 顔テンプレート正本・同意・export と Aedilis 受理ポリシー

## 目的

Ostiarius が期待する連携先契約 ([interface/cernere-face-template.md](../interface/cernere-face-template.md)、
[feature/identity-verification.md](../feature/identity-verification.md) §6) を Cernere / Aedilis 側に実装する。
2 リポにまたがるため **Cernere PR と Aedilis PR の 2 本** (Ostiarius 側は無し)。

## 完了条件 — Cernere
- [ ] `spec/feature/face-template-store.md` を Ostiarius `interface/cernere-face-template.md` から起こす (Cernere 側正本)。
- [ ] テーブル: `face_templates` (userId, template_enc [保存鍵 AES-GCM], key_id, model_id, quality, version, facility_id, enrolled_by, consent_id, revoked_at)、`face_consents` (userId, policy_version, facility_id, at, revoked_at)、tombstone。migration 番号は未マージ並行ブランチも見て採番。
- [ ] `GET /api/identity/face-template/export?facilityId=` (service scope `face-template:export`、施設配布鍵で再暗号化、全量 + revoked 30 日)。
- [ ] `PUT /api/identity/face-template` (service + enrolledBy + consentId 検証)、`DELETE` 2 種、`POST /api/identity/face-consent`、`GET /api/identity/face-consent/policy`。
- [ ] `GET /api/identity/roster?facilityId=` (userId + 弱識別 hint + roles のみ)。
- [ ] passkey export に `roles` / `facilityIds`、`?facilityId=` 絞り込み。
- [ ] 保持: 所属離脱・卒業・撤回・365 日再同意なしで削除 (既存の退会/離脱処理にフック)。audit ログ。
- [ ] フロント: プロフィールに「顔認証の登録状態 / 削除」項目。
- [ ] テスト + 1 PR。

## 完了条件 — Aedilis
- [ ] `checkin-spike/CONTRACTS.md` §1 に `method` / `assurance` を追記 (旧 5 フィールドのみの attestation も受理)。
- [ ] `checkin_events` (相当) に `method` / `assurance` 列を追加、受理ポリシー `CHECKIN_MIN_ASSURANCE` (既定 `medium`; `low` は明示設定時のみ)。
- [ ] `staff_override` は受理しつつ管理画面/日次通知で件数表示。`passkey` の連続使用 (同一 user が N 日連続 passkey のみ) を注意表示 (閾値設定)。
- [ ] `POST /api/checkin/gateway-verify` を追加: 既存 `/api/checkin/verify` は生徒本人 token + `sub` 一致必須 (`server/checkin/service.ts` `subject_mismatch`) なので kiosk (Ostiarius) 直接送信用に、gateway 登録済み公開鍵で attestation を検証 + `AEDILIS_GATEWAY_TOKEN` (gateway ごと、`/admin/gateways` 登録時に払い出し) の Bearer で認可する経路を作る。`processCheckin` の署名検証・重複判定は共通化して再利用。
- [ ] Ostiarius 側 (P2 の outbox 送信先) はこの endpoint 名で固定 (`feature/face-verification.md` §5)。
- [ ] `POST /api/checkin/events-summary` (Ostiarius outbox `aedilis:events`、件数のみ) を追加。
- [ ] テスト + 1 PR。

## スコープ外
- Ostiarius 側の変更 (P1/P2)。保護者同意の記録 (未決)。
