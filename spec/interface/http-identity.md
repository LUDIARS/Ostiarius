# interface: `/identity/*` HTTP エンドポイント (本人確認ゲート)

[http-checkin.md](http-checkin.md) に追加する接点。listen / CORS は同じ。
`/kiosk` `/enroll` の画面と `/identity/*` は **同一ホストのブラウザ** から使う前提だが、
LAN 内の他端末から叩かれないよう `X-Ostiarius-Kiosk: {OSTIARIUS_KIOSK_TOKEN}` ヘッダを要求する
(生徒端末が使うのは従来の `/checkin/*` PWA 経路のみ)。

## セッション

### `POST /identity/session`
- req: `{ purpose: 'verify' | 'enroll' }`
- res 200: `{ sessionId, expiresAt }` (TTL 60s、フレーム/操作ごとに延長)

### `GET /identity/session/:id`
- res 200: `{ state, method?, result?, fallback?: { passkeyQrUrl?, deviceLinkQrUrl? } }`
  - `state`: `idle | scanning | challenging | issued | fallback | expired`
  - kiosk はこれをポーリング (1s) してパスキー完了なども反映

## 顔認証

### `POST /identity/face/frame`
- req: `multipart/form-data` `sessionId`, `frame` (JPEG ≤ 200KB)
- res 200:
  ```jsonc
  { "state": "scanning" | "challenging" | "issued" | "fallback",
    "hint": "no_face" | "too_small" | "turn_to_camera" | "hold_still" | "spoof_retry" | "no_match" | "ambiguous" | null,
    "challenge": { "kind": "blink" | "turn_left" | "turn_right" | "nod", "deadline": 1723800000000 } | null,
    "result": { "subjectHint": "K.M. / 42", "assurance": "high" } | null }
  ```
- res 409 `{ error: 'face_disabled' }` (sidecar 未設定)、410 `{ error: 'session_expired' }`。
- issued 時、attestation は返さない (kiosk には不要。Ostiarius が Aedilis へ送る)。
  デバッグ用に `?includeAttestation=1` + kiosk token で返せる。

## パスキー (kiosk 導線)

### `POST /identity/passkey/begin` / `POST /identity/passkey/finish`
- 既存 `/checkin/begin|finish` と同一仕様 ([http-checkin.md](http-checkin.md))。差分:
  - begin req: `{ sessionId? }` — kiosk セッションに紐づける (任意)。生徒端末 PWA からは省略可。
  - finish res: `{ ok, attestation, method: 'passkey', assurance: 'medium' }`
  - 紐づいたセッションがあれば `state=issued` に遷移。

### `GET /identity/passkey/register-hint`
- res 200: `{ registerUrl: "{CERNERE_FRONTEND_URL}/profile#passkey", qrSvg }` — 生徒が自分のスマホで
  Cernere にログインしてパスキーを追加するための QR。Ostiarius は Cernere API を呼ばず、生徒の
  bearer も扱わない ([../feature/passkey-fallback.md](../feature/passkey-fallback.md) §1)。
  env `CERNERE_FRONTEND_URL` (未設定なら `CERNERE_BASE_URL`)。

## 登録

### `POST /identity/enroll/start`
- req: `{ sessionId, staffAssertion: AuthenticationResponseJSON, studentAuthCode }`
- 処理: 職員 assertion 検証 (roles) → 生徒 authCode を Cernere で交換して userId 確定 →
  同意ポリシーを返す
- res 200: `{ enrollId, student: { userId, hint }, consent: { policyVersion, text } , shots: { required: 6 } }`

### `POST /identity/enroll/consent`
- req: `{ enrollId, accepted: true }` → Cernere に同意を先行記録 (`POST /api/identity/face-consent`)

### `POST /identity/enroll/frame`
- req: multipart `enrollId`, `frame`, `pose` (`front|left|right|up|glasses|noglasses`)
- res 200: `{ accepted: bool, hint, shotsDone, shotsRequired, warning?: 'duplicate_of_other_user' }`

### `POST /identity/enroll/commit`
- 平均テンプレート → Cernere `PUT /api/identity/face-template` → ローカル upsert
- res 200: `{ ok: true, version }`

### `DELETE /identity/enroll/:enrollId` — 中断 (メモリ上のショットを破棄)

## 職員 override

### `POST /identity/staff/begin` / `POST /identity/staff/finish`
- passkey と同じだが `roles` に `OSTIARIUS_STAFF_ROLES` を含む credential のみ受理。
- finish res: `{ ok, staffSession }` (TTL 10 分、`X-Ostiarius-Staff` ヘッダで以降の職員操作に付ける)

### `GET /identity/staff/roster?q=`
- 名簿検索 (Cernere `GET /api/identity/roster?facilityId=` のキャッシュ、userId + 弱識別のみ)

### `POST /identity/staff/override`
- req: `{ subjectUserId, reasonCode: 'camera_down' | 'face_reject' | 'no_device' | 'other', reasonText? }`
- res 200: `{ ok, method: 'staff_override' }` (attestation は Aedilis へ送信)。日次上限超過 429。

## 管理

### `POST /identity/admin/sync` — 即時 sync (職員セッション必須)
### `GET /api/health` — 既存に `faceTemplates` 件数 / `sidecar: { ok, modelId }` / `outbox` 件数を追加
