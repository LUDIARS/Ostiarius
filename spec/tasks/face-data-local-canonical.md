# 顔テンプレート・顔写真を Ostiarius のローカル正本へ昇格する

## 目的

顔テンプレートと顔写真の正本を Cernere から **Ostiarius (施設 kiosk ホスト)** へ移し、
生体情報を施設外へ一切出さない ([`../plan/face-data-local-only.md`](../plan/face-data-local-only.md) §2〜§6)。

変更前は Cernere が正本で、Ostiarius は 15 分ごとに export を取り込む施設キャッシュだった。
この構成では Cernere の侵害・誤設定・バックアップ流出がそのまま全施設の生体情報流出になる。
照合はもともと施設内で完結しているので、正本をローカルへ移し、Cernere には
**同意記録と失効指示だけ**を残す。鍵も同じ理由で kiosk ホスト内生成にし、Infisical から配らない。

## 実装内容

### 1. データ層 (`server/db.ts`)

- `face_templates` を正本テーブルへ昇格: `facility_id` / `key_id` / `state`
  (`pending` | `active` | `revoked`) / `consent_id` / `enrolled_by` / `revoked_at` / `revoke_reason` を追加。
- `face_photos` (封緘済み写真 1 枚 + `key_id` + `content_type` + `consent_id`) と
  `face_consents_copy` (`consent_id` / `policy_version` / `at` / `revoked_at`) を新設。
- 同期の再開位置を持つ `sync_state` を新設。
- 起動時マイグレーション: 旧同期キャッシュ (`synced_at` を持ち `state` を持たない `face_templates`) は
  **破棄**する。旧行は廃止した配布鍵で封緘されており復号できないため
  (`face-data-local-only.md` §6-2 のとおり既登録者は kiosk で再 enroll)。
- `purgeFaceSubject` — テンプレート・写真・同意の写しを 1 トランザクションで物理削除。
  削除経路はすべてここを通し、片方だけ残る状態を作らない。
- `server/face/local-store.ts` (新設) が平文 ⇄ 封緘済み blob の境界になり、`db.ts` は
  blob と `key_id` しか扱わない (`createCipheriv` を持たない)。

### 2. 鍵管理 (`server/face/local-key.ts` 新設)

- テンプレート鍵・写真鍵を kiosk ホスト内で生成し、`OSTIARIUS_DATA/face-keys.json` に 0600 で保存。
  鍵 ID 付きで用途ごとに別鍵、過去鍵も保持して `key_id` から引く。
- `OSTIARIUS_TEMPLATE_KEY` の env / Infisical 配布を廃止 (`server/config.ts` /
  `env-cli.config.ts` / `excubitor.catalog.yaml` / `spec/setup/*` から除去)。
- TPM 封緘 / OS 資格情報ストアは `face-data-local-only.md` §8 の未決事項なので鍵ファイルのみ実装し、
  ホストのディスク暗号化が必須条件であることを README に明記した。

### 3. 登録 (`server/routes/identity-enroll.ts` / `identity-review.ts` / `server/face/`)

- 職員立会い enroll のテンプレートを Cernere へ PUT せず、ローカルへ封緘保存する (`state='active'`)。
- `POST /identity/enroll/photo` を追加 (LAN 内 + 職員セッション)。写真をローカルに封緘保存し、
  ローカル sidecar で抽出した 512d を `pending` で保管する。顔を検出できない写真は
  写真もテンプレートも保存しない。
- 承認 / 却下をローカル実行 (`server/face/review-service.ts`)。却下は理由必須で、写真と `pending` を同時に削除。
  `active` 化は次のフレームの roster へ即時反映される (`server/face/template-roster.ts` が
  `state='active'` かつ同意が有効な行だけを組み直す)。審査候補は
  `server/face/review-candidates.ts` がローカル `pending` + Cernere 名簿から出す。
- `DELETE /identity/enroll/registration/:userId` — kiosk 上での本人削除 (職員立会い)。
  ローカルを即時削除し、Cernere への同意撤回は outbox で再送する。
- 同意記録は従来どおり Cernere (`POST /api/identity/face-consent`、生徒 authCode → 本人 token)。
  保存先を明記した新 `policyVersion` (`face-local-v2`) を使い、Cernere が未対応の間は旧版へ落とす。
  接点は `server/face/cernere-consent-client.ts` (同意の記録と撤回だけ。生体情報を運ばない)、
  撤回の再送は `server/face/consent-outbox.ts`。テンプレート PUT の
  `server/face/cernere-template-client.ts` と写真取得の `server/face/cernere-photo-client.ts`、
  export 同期の `server/face/template-sync.ts` は撤去した。

### 4. 同期 (`server/cernere-sync.ts` / `server/face/revocation-sync.ts` 新設)

- Cernere の face-template export の取得を廃止し、
  `GET /api/identity/face-revocations?facilityId=&since=` と `GET /api/identity/face-consents?facilityId=`
  の pull に置換 (passkey 同期と同じ 15 分周期 + 職員の即時 sync `POST /identity/admin/sync`)。
- 失効指示を受けたらテンプレート・写真・同意の写しを物理削除する。
- 同意の写しから 365 日超過・`revokedAt` を自前判定し、照合 roster から外す (Cernere 不通時の保険)。
- Cernere 側の新 API はまだ無い可能性があるため、404 は warn に留めて既存動作を壊さない。
- `since` 未記録 (初回・バックアップ復元直後) は 30 日前から全量を取り直す。

### 5. 写真閲覧 API (`server/routes/identity-staff.ts`)

`GET /identity/face-photo/:userId` — LAN 内 (`server/face/lan-guard.ts` が接続元と中継ヘッダを見る) + 職員セッション必須、
1 件ずつ、`Cache-Control: private, no-store`、閲覧を監査ログに記録。kiosk 待機画面には出さない。

### 6. バックアップ (`server/face/backup.ts` 新設)

`OSTIARIUS_BACKUP_DIR` へ日次で暗号化 DB をオンラインバックアップし、直近 7 世代でローテートする。
鍵ファイルは複製しない。バックアップ先が `OSTIARIUS_DATA` と同じ場合は拒否する。
復元手順 (失効指示 30 日分を先に適用) は `docs/E2E-identity.md` に記載した。

### 7. テスト・文書

- 追加: `test/face-local-key.test.ts` / `test/face-revocation-sync.test.ts` /
  `test/face-photo-api.test.ts` / `test/face-backup.test.ts`。
- 書き換え: `test/face.test.ts` / `test/face-review.test.ts` /
  `test/identity-enroll-consent.test.ts` の Cernere export 前提、`test/no-biometric-log.test.ts` の検査範囲。
- README / `spec/setup/configuration.md` / `spec/setup/secrets.md` / `docs/E2E-identity.md` /
  `spec/feature/face-enrollment.md` / `spec/interface/http-identity.md` を実装に合わせて更新。
- 受け入れ条件は Augur の契約 (C-1〜C-6) として `augur.contracts.json` + `contracts/*.contract.ts` に置き、
  `server/contract-runtime.ts` が観測する (対象関数の戻り値・例外・同期非同期性は変えない)。

## 完了条件

- Cernere の face-template export / PUT / face-photo API への呼び出しがコードから消えている
  (`test/no-biometric-log.test.ts` が `api/identity/face-template` と `api/identity/face-photo` の
  不在を検査する)。
- `OSTIARIUS_TEMPLATE_KEY` が `server/config.ts` / `env-cli.config.ts` / `excubitor.catalog.yaml` から
  消えており、鍵はホスト内生成の鍵ファイルだけで賄える。
- テンプレート・写真の平文がディスクへ落ちる経路が無い (DB 列は封緘済み blob、
  鍵ファイルとバックアップにも平文が入らないことをテストで確認)。
- 写真とテンプレートと同意の写しが常に同時に消える (失効指示・却下・本人削除のすべて)。
- `pending` テンプレートが照合 roster に載らず、同意が撤回・365 日超過なら照合から外れる。
- 写真閲覧 API が LAN 内 + 職員セッションの両方を要求し、閲覧を監査ログに残す。
- `npm run typecheck` と `npm test` が緑。
