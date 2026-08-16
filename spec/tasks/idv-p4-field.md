---
task: idv-p4-field
project: Ostiarius
kind: 検証
status: planned
created: 2026-08-16T00:00:00.000Z
delegation_run_id: null
memoria_task_id: 1048
actio_task_id: null
memory_links: []
---
# P4: 実機確認 (登録 → 顔認証 → パスキー代替 → 出席記録)

人手 (neco / 職員 / カメラ付き kiosk / 生徒端末) が要る。委託ではなく共同で行う。

## 手順 (チェックリスト)
- [ ] kiosk ホスト (Windows PC or Raspberry Pi 5) に Ostiarius + face-sidecar を Excubitor 経由で起動、`/api/health` で `sidecar.ok` / `methods` を確認。
- [ ] Infisical から `OSTIARIUS_TEMPLATE_KEY` / `CERNERE_SERVICE_TOKEN` / `OSTIARIUS_KIOSK_TOKEN` を inject。
- [ ] 職員 passkey で `/enroll` を開き、同意済み職員 3 名 + 生徒役 5 名を登録 (各 6 ショット)。重複警告が出ないこと。
- [ ] Cernere export → Ostiarius sync でテンプレート件数が一致 (`faceTemplates`)。
- [ ] 顔認証: 各人 5 回、issued までのフレーム数・時間・チャレンジ成功率を記録。誤拒否率 ≤ 5% を初期目標。
- [ ] spoof: スマホ画面の顔写真 / 印刷写真を各 20 回提示 → `spoof_suspected` になること (検出率を記録)。
- [ ] 別人 (未登録) が立つ → `no_match` → パスキー QR 表示。
- [ ] パスキー: 生徒端末で device-link 登録 → 翌フローで `/checkin` assertion → `method=passkey` の出席が Aedilis に記録される。
- [ ] 職員 override: 理由入力 → `staff_override` が Aedilis に記録され、日次件数表示に出る。
- [ ] 撤回: 生徒が Cernere で削除 → 15 分以内 (or 即時 sync) に kiosk で `no_match` になる。
- [ ] Aedilis 停止中に issued → outbox → 復旧後に自動送信される。
- [ ] 閾値 (`OSTIARIUS_FACE_MATCH_THRESHOLD` / `MARGIN` / `LIVENESS`) を実測で確定し `spec/setup/configuration.md` に施設値として記録。
- [ ] 誤拒否が多ければ AdaFace IR-101 でオフライン比較 ([plan/face-model-selection.md](../plan/face-model-selection.md) §5)。

## 成果物
- `docs/E2E-identity.md` に実測結果と確定閾値、既知の弱点 (3D マスク等) を記録。
- Memoria #1048 を done、#507 (LAN TLS) を本タスクの決定により done。
