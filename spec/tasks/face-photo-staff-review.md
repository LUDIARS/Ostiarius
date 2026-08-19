# プロフィール写真由来 pending テンプレートの職員承認 (kiosk /enroll)

## 目的

生徒が GLab のプロフィールへ出した顔写真から Cernere が作る `pending` テンプレートを、
職員が実機 (kiosk `/enroll`) で本人確認して `active` へ昇格させる経路を Ostiarius に実装する。

写真は「登録の手間を減らす種」であり、本人性の判断は従来どおり職員が実機で行う
(`spec/feature/face-photo-seeded-enrollment.md` §1)。職員の作業を「5〜8 ショット撮影」から
「画面の写真と目の前の顔を照合して承認」へ軽くする。従来の職員立会い登録
(`spec/feature/face-enrollment.md`) は廃止せず併存させる。

## 実装内容

### 1. Cernere 接点 (`server/face/`)

- `cernere-photo-client.ts` — 写真取得 (1 件ずつ) / promote / reject。scope 付き token を使う。
  写真バイトは戻り値としてのみ扱い、ディスクにもログにも残さない。
- `cernere-template-client.ts` — 同意記録 + テンプレート登録。職員立会い enroll と
  撮り直し承認の両方が使う (fetch の重複を 1 箇所へ)。
- `review-candidates.ts` — Cernere に pending 一覧 API が無いため、施設名簿
  (`GET /api/identity/roster`) からローカルキャッシュの `active` を差し引いて審査候補を出す。
  写真は職員が 1 人を選んだ時点で都度取得する (一覧で一括取得しない)。
- `review-service.ts` — 承認 (reenroll / promote-photo) と却下のオーケストレーション。

### 2. 審査 API (`server/routes/identity-review.ts`)

`GET /identity/review/candidates` / `GET /identity/review/photo/:userId` /
`POST /identity/review/reenroll/start` / `POST /identity/review/approve` /
`POST /identity/review/reject`。すべて職員パスキーで確立した staff session
(`x-ostiarius-staff`) を要求する (`staff_override` と同じ経路)。
写真応答には `Cache-Control: private, no-store` を付ける。

### 3. kiosk 承認パネル (`server/routes/kiosk-review-panel.ts`)

候補一覧 → 写真表示 → 承認 (既定は撮り直し) / 却下 (理由必須)。
写真は職員の承認画面にだけ出す。出席確認 kiosk の一般画面には出さない。

### 4. 二重防御

Cernere の export は `active` のみ返すが、`server/face/template-sync.ts` でも `state` を検証し、
`pending` が混ざっても施設キャッシュ・照合器に載せない。

## 完了条件

- 写真由来の `pending` テンプレートが施設キャッシュにも照合器 (`buildFaceRoster`) にも載らない。
- 理由を入力しない却下は Cernere へ送られず 400 で止まる (UI もボタンを押せない)。
- 撮り直し承認 (`mode=reenroll`) 後、`active` テンプレートが施設キャッシュへ即時に入る。
- 写真の取得〜表示で、ファイル書き込み (`writeFile` / `appendFile` / `createWriteStream`) が
  1 度も呼ばれない。
- 顔・写真経路のソースに写真バイト・埋め込みをログへ出す箇所が無い
  (`test/no-biometric-log.test.ts` を写真経路まで拡張)。
- `npm run typecheck` が新規エラー無しで通り、`npm test` が通る。
- 従来の職員立会い enroll がそのまま使える。

## 前提未確定 (運用側で埋める)

- `CERNERE_FACE_PHOTO_TOKEN`: scope `face-photo:read` / `face-photo:manage` を持つ token。
  Cernere の `service-scope-auth.ts:41-44` は project token を拒否するため、export 用の
  project credential 由来Bearer（または固定tokenの代替経路）とは別に払い出す。
- `OSTIARIUS_FACE_REVIEWER_USER_ID`: Cernere 上の審査者 userId。`face-photo-handler.ts:104-116`
  が `enrolledBy` と token の主体の一致を強制するため、kiosk のその場の職員 ID は載せられない。
  実際に承認した職員は Ostiarius の `face_events` に actor として残す (二重記録)。
- 両方が未設定なら承認パネルも審査 API も公開しない (出席確認と従来 enroll には影響しない)。
