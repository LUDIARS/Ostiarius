# E2E — 本人確認ゲート (顔認証 + パスキー) 実機 runbook (P4)

`spec/tasks/idv-p4-field.md` の実施手順と記録欄。人手 (職員立会い・カメラ付き kiosk・生徒端末) が要る部分の
正本。設計は `spec/feature/identity-verification.md`、旧パスキー経路の E2E は `docs/E2E-checkin.md`。

## A. 事前準備 (実機なしでできる。2026-08-17 時点の状態を [ ] に記す)

### A-1. Secret / env (Infisical `Ostiarius` project、env-cli `include` は `excubitor.catalog.yaml`)

| key | 置き場 | 値の作り方 | 状態 |
|---|---|---|---|
| `OSTIARIUS_KIOSK_TOKEN` | Infisical Ostiarius | `openssl rand -base64 32` | [ ] |
| 顔データの封緘鍵 | kiosk ホスト (`OSTIARIUS_DATA/face-keys.json`) | **配布しない**。初回起動時にホスト内で自動生成される (0600、テンプレート鍵と写真鍵は別)。ホストのディスク暗号化が前提 | [ ] |
| `OSTIARIUS_BACKUP_DIR` | kiosk ホスト env | 施設内媒体 (USB / NAS) のパス。**鍵ファイルとは別媒体**にする | [ ] |
| `AEDILIS_GATEWAY_TOKEN` | Infisical Ostiarius | Aedilis `POST /admin/gateways` (admin) の応答で 1 回だけ返る平文 token | [ ] |
| `CERNERE_FRONTEND_URL` | Infisical Ostiarius (非 secret) | Cernere frontend origin (`/profile#passkey` の QR 元) | [ ] |
| `CHECKIN_MIN_ASSURANCE` | Aedilis env | 既定 `medium` (パスキー/顔を受理、legacy `low` は拒否) | [ ] |

既存 (`CERNERE_PROJECT_CLIENT_ID` / `CERNERE_PROJECT_CLIENT_SECRET` または一時用の
`CERNERE_SERVICE_TOKEN`、`OSTIARIUS_PRIVATE_KEY`、`AEDILIS_ADMIN_TOKEN`、RP ID / origin) は
`docs/E2E-checkin.md` §B の通り。

### A-2. face-sidecar (kiosk ホスト)

```bash
cd Ostiarius/face-sidecar
python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -e . pytest httpx
python scripts/fetch-models.py                     # models/ に 4 ファイル (SHA-256 検証済み)
python -m pytest -q                                # 4 tests
uvicorn face_sidecar.app:app --host 127.0.0.1 --port 17591
curl -s http://127.0.0.1:17591/v1/health           # {"ok":true,"modelId":"insightface/glintr100@1",...}
```

- `ok:false` ならモデル欠落 (stderr に missing 一覧)。Ostiarius 側は `/api/health` の `sidecar.ok=false` を見て顔経路を fallback 表示にする。
- 起動は Excubitor 経由 (`ostiarius-face-sidecar`、port は catalog 払い出し。17591 は仮既定)。モデル置き場は env `FACE_SIDECAR_MODELS_DIR` (既定 `face-sidecar/models`)。
- Windows でこのホスト (開発機) の python.exe が「ログオンセッションが存在しません」で起動できない事象あり → kiosk 実機か WSL で行う。

> **2026-09-12 の方針変更**: 顔テンプレート・顔写真の正本は Ostiarius (施設 kiosk ホスト) にあり、
> Cernere は同意記録と失効指示だけを持つ ([`../spec/plan/face-data-local-only.md`](../spec/plan/face-data-local-only.md))。
> 鍵の配布 (`OSTIARIUS_TEMPLATE_KEY` / `FACE_TEMPLATE_DISTRIBUTION_KEYS`) は廃止した。

### A-3. Cernere / Aedilis 側

- [ ] Cernere: migration 適用 (face_consents)、`GET /api/identity/face-consent/policy` が同意文 (version) を返す。
- [ ] Cernere: 新 policyVersion `face-local-v2` (保存先は施設の kiosk 端末のみ) を受理する。
      未対応の間、Ostiarius は旧 `face-template-v1` へ自動で落とす (同意経路は止まらない)。
- [ ] Cernere: `GET /api/identity/face-revocations` / `GET /api/identity/face-consents` /
      `POST /api/identity/face-consent/revoke` (`spec/interface/cernere-face-template.md` §A)。
      未実装の間は 404 を warn として扱い、ローカル正本での照合は継続する。
- [ ] Cernere: 職員ユーザに role `staff` (or `admin`)、生徒ユーザが facility 所属 → `GET /api/auth/passkey/export?facilityId=` に `roles` / `facilityIds` が出る。
- [ ] Aedilis: `/admin/gateways` にこの Ostiarius (lanId, 公開鍵) が登録済み、gateway token を Ostiarius へ。
- [ ] Ostiarius `/api/health`: `methods` に `face` / `passkey`、`faceTemplates` 件数、`sidecar.ok`、`outbox` 件数。

## B. 実機シナリオ (記録欄)

| # | シナリオ | 期待 | 結果 / 実測 |
|---|---|---|---|
| 1 | 職員 passkey で `/kiosk` → 「顔を登録（職員）」→ 生徒が Cernere ログイン → 同意 → 6 ショット | Ostiarius `faceTemplates` +1 (`state=active`)、Cernere へテンプレートは送られない | |
| 1b | 同じ登録セッションで顔写真を提出 | `facePending` +1、職員の承認まで照合に載らない。写真は `GET /identity/face-photo/:userId` で LAN 内の職員だけが見られる | |
| 2 | 登録者 5 名 × 5 回の顔認証 | issued まで ≤ 10 フレーム、チャレンジ成功率、誤拒否率 ≤ 5% | |
| 3 | スマホ画面の顔写真 / 印刷写真 各 20 回 | `spoof_suspected` (利用者には「もう一度」表示) 検出率 | |
| 4 | 未登録者が立つ | `no_match` → パスキー QR 表示 | |
| 5 | 生徒スマホで Cernere パスキー登録 → 翌フローで `/checkin` assertion | Aedilis に `method=passkey` `assurance=medium` | |
| 6 | 職員 override (理由 `face_reject`) | Aedilis に `staff_override`、日次件数表示、同一職員の 21 件目で 429 | |
| 7 | 生徒が Cernere で顔登録削除 | 失効指示の pull (`POST /identity/admin/sync` で即時 / ≤ 15 分) でテンプレート・写真・同意の写しが消え `no_match` | |
| 7b | kiosk 上で本人が削除 (職員立会い) | ローカルは即時削除、Cernere への同意撤回は outbox で再送される | |
| 8 | Aedilis 停止中に issued → 復旧 | outbox に滞留 → 自動再送で attendance 記録 | |
| 9 | 閾値確定 | `OSTIARIUS_FACE_MATCH_THRESHOLD` / `_MARGIN` / `OSTIARIUS_LIVENESS_THRESHOLD` の施設値を `spec/setup/configuration.md` に記録 | |

## B-2. バックアップと復元 (2026-09-12 追加)

`OSTIARIUS_BACKUP_DIR` を設定すると、起動時と日次で暗号化 DB を複製する (直近 7 世代、
`ostiarius-<UTC timestamp>.db`)。**鍵ファイルは複製されない** ので、鍵は別媒体へ手で退避する。

| # | 手順 | 期待 |
|---|---|---|
| B2-1 | `OSTIARIUS_BACKUP_DIR` を施設内媒体に設定して起動 | 媒体に `ostiarius-*.db` が 1 世代でき、8 回目以降は最古が消える |
| B2-2 | 鍵ファイル (`OSTIARIUS_DATA/face-keys.json`) を別媒体へ退避 | バックアップ媒体に鍵が無いこと |

### 復元手順

1. サービスを停止する。
2. バックアップの `ostiarius-*.db` を `OSTIARIUS_DATA/ostiarius.db` へ戻し、退避した
   `face-keys.json` を `OSTIARIUS_DATA` へ戻す (鍵が無いと全登録が開けない)。
3. **照合を再開する前に失効指示を適用する。** 復元した DB には削除済みの人物が残っているため、
   `sync_state` の `face_revocations_since` を消してから起動する (未記録なら Ostiarius が
   自動で 30 日前から全量を取り直す)。職員が `POST /identity/admin/sync` を叩けば即時に適用できる。
4. `/api/health` の `faceTemplates` / `facePending` が期待値になったことを確認してから運用へ戻す。

## C. 判定と残課題

- 誤拒否が多い場合: `plan/face-model-selection.md` §5 の AdaFace IR-101 オフライン比較。
- 既知の弱点 (設計上): 高品質 3D マスク、職員共謀による enroll なりすまし → 物理監督で補完。
- 完了時: Memoria #1048 を done、#507 (LAN TLS) は本再設計の決定により done。
