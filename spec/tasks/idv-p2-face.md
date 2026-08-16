---
task: idv-p2-face
project: Ostiarius
kind: 実装
status: implemented
created: 2026-08-16T00:00:00.000Z
delegation_run_id: null
memoria_task_id: 1048
actio_task_id: null
memory_links: []
---
# P2: 顔認証 + 生体性 (face-sidecar / enroll / verify / kiosk UI)

## 目的

kiosk のカメラで 1:N 顔照合 + 生体性確認を行い attestation を発行する主経路を実装する。
設計正本: [feature/face-verification.md](../feature/face-verification.md)、
[feature/face-enrollment.md](../feature/face-enrollment.md)、[interface/face-sidecar.md](../interface/face-sidecar.md)、
[interface/http-identity.md](../interface/http-identity.md)、[data/face-templates.md](../data/face-templates.md)、
[plan/face-model-selection.md](../plan/face-model-selection.md)。P1 の上に積む。

## 完了条件

### face-sidecar (Python、`face-sidecar/`)
- [x] `fetch-models.py`: SCRFD-10G / glintr100 (antelopev2) / MiniFASNetV2 / MediaPipe face_landmarker を配布元から取得し SHA-256 検証。Vultus のコードは import しない。
- [x] `GET /v1/health` / `POST /v1/analyze` / `POST /v1/embed-batch` を interface 通りに実装 (127.0.0.1 のみ listen、キュー長 1、画像はディスクに書かない)。
- [x] 品質ゲート、5 点アライン → 112x112、L2 正規化 embedding、liveness スコア、blendshapes/pose (want 指定時)。
- [x] pytest: 合成画像/公開サンプルで各エンドポイントの形と品質ゲートを検証。Excubitor catalog 断片を追加 (port は catalog で払い出す。仮 17591)。

### Ostiarius 本体
- [x] `face_templates` (AES-GCM、`OSTIARIUS_TEMPLATE_KEY`) と `outbox` テーブル、roster メモリ (Float32Array) の構築・再構築。
- [x] Cernere face-template export sync (`cernere-sync.ts` と同パターン、全量スナップショット + tombstone)。P3 未完なら `OSTIARIUS_FACE_TEMPLATE_SOURCE=local` でローカル enroll のみでも動く (Cernere PUT はスキップし警告)。
- [x] `POST /identity/face/frame`: state machine (idle/scanning/challenging/issued/fallback)、判定ルール (閾値・margin・連続 3 フレーム)、ランダムチャレンジ (blink/turn/nod、8s)、issued で attestation `method=face|face_passive` を Aedilis へ直接 POST (失敗は outbox 再送)。
- [x] enroll API (`/identity/enroll/start|consent|frame|commit`、DELETE): 職員 passkey 認可 → 生徒 authCode 交換 → 同意 → 6 ショット → 平均テンプレート → Cernere PUT (or local) → ローカル upsert。既登録との重複警告。
- [x] 職員 override (`/identity/staff/*`)、名簿検索 (Cernere roster or ローカル user_id 一覧)、日次上限。
- [x] kiosk UI: 顔認証待機 → 案内 hint → チャレンジ指示 → 完了 (弱識別のみ表示)。enroll 画面 (同意文表示、ポーズ指示、進捗)。カメラ 5fps → 待機時 1fps。
- [x] `verification_events` 記録 (失敗行に user を入れない)、90 日ローテート。ログに画像/テンプレート/氏名を出さない test。
- [x] `/api/health` に `faceTemplates` / `sidecar` / `outbox`。
- [x] vitest: matcher (閾値・margin・投票)、チャレンジ判定、state machine、テンプレート暗号化 round-trip、sync tombstone、outbox 再送。sidecar はモック。
- [ ] `npm run typecheck` / `npm test` / sidecar pytest 成功。1 PR (Ostiarius) + Excubitor catalog 断片。
  - 注: sidecar pytest はこの Windows ホストで python.exe が起動できず (ログオンセッション不在) 未実行。P4 実機環境 (venv + モデル取得後) で実行する。typecheck / vitest (64 tests) は作者報告で成功、本PRレビューでは未実行。

## スコープ外
- Cernere / Aedilis 側 API (P3)。実機閾値調整 (P4)。
