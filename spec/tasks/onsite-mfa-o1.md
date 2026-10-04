---
task: onsite-mfa-o1
project: Ostiarius
kind: 実装
status: in_review
created: 2026-10-04T00:00:00.000Z
delegation_run_id: 48dfae23-79f7-459f-91e2-4993814ad887
memoria_task_id: null
actio_task_id: "actio:52c388d6-dfb6-455a-baa8-b40ce8053293"
memory_links: []
---
# O1: 現地確認 MFA (onsite factor) の Ostiarius 側

設計: [../feature/onsite-mfa-factor.md](../feature/onsite-mfa-factor.md) §2.1.1 / §3 / §7。
Cernere 側 (C1/C2) と Aedilis 側 (A1) は別リポのタスク。

## 分解
- [x] attestation の `purpose` 末尾追加・固定キー順での署名・旧形式 (purpose 欠落 = attendance) の読み取り (`server/attestation.ts`)
- [x] 出席経路 (passkey / 顔 / 職員 override / session / password) に `purpose: "attendance"` を明示
- [x] MFA セッション: 1 kiosk 1 セッション (`kiosk_busy`)・5 分期限 (`server/onsite-mfa/session-store.ts`)
- [x] LAN 限定の端末向け API と Cernere origin だけの CORS (`server/routes/onsite-mfa.ts`)
- [x] kiosk 側 API (確認待ち・顔・パスキー) と kiosk 画面の確認待ちパネル (`server/routes/onsite-mfa-kiosk.ts`, `kiosk-mfa-panel.ts`)
- [x] `purpose: "mfa"` の署名と Cernere への送信、拒否コードの状態反映 (`server/onsite-mfa/completion.ts`, `cernere-submit.ts`)
- [x] 契約 C-10〜C-14 (augur.contracts.json) とテスト (`test/onsite-mfa.test.ts`, `test/attestation-purpose.test.ts`)

## 人間 (neco) に残す運用手順
- [ ] Cernere の Ostiarius project の `service_scopes` に `onsite-mfa:submit` を宣言する
- [ ] kiosk 公開鍵 (`GET /gateway-public-key` の値) を Cernere の `POST /api/admin/onsite-kiosks` で登録する
- [ ] 対象サービスの `onsite_mfa` を設定する
- [ ] F1 実機確認 (2026-10-04 の所在確認 P4 の後)
