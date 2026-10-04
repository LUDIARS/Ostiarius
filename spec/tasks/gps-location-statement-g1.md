---
task: gps-location-statement-g1
project: Ostiarius
kind: 実装
status: in_review
created: 2026-10-05T00:00:00.000Z
delegation_run_id: 9bd73221-fe16-4cc6-a5bf-fb96c4321ded
memoria_task_id: null
actio_task_id: "actio:ed838229-a7a5-4518-beaa-8790d6d91906"
memory_links: []
---
# G1: GPS チェックインの位置の宣言 (Ostiarius 側)

設計: [../feature/gps-location-statement.md](../feature/gps-location-statement.md)。
G2 (GLAB) と G3 (Aedilis) は別リポのタスク。

## 分解
- [x] 設定 3 値の解決 (`server/facility-location.ts`、`server/config.ts`)
- [x] attestation の purpose 型に `location` を追加し、署名の共通部を `signCompactPayload` に切り出す (`server/attestation.ts`)
- [x] 位置の宣言の署名と要求ごとの発行 (`server/location-statement.ts`)
- [x] `/api/health` の `locationStatement` と `GET /api/location` (`server/index.ts`、`server/routes/location.ts`)
- [x] catalog の env コメント (`excubitor.catalog.yaml`)
- [x] 契約 C-22 / C-23 とテスト (`test/location-statement.test.ts`)

## 人間 (neco) に残す運用手順
- [ ] Vault に `OSTIARIUS_FACILITY_LAT` / `OSTIARIUS_FACILITY_LON` / `OSTIARIUS_FACILITY_RADIUS_M` を登録して ostiarius に紐付け、再起動する
