# interface: Cernere 顔テンプレート / 同意 / 名簿 (連携先 — P3 で Cernere に追加)

Ostiarius が **クライアント側**。Cernere に追加する接点の契約。Cernere 側の正本 spec は
P3 で `Cernere/spec/feature/face-template-store.md` として起こす (本ファイルを転記)。
passkey export ([cernere-passkey-export.md](cernere-passkey-export.md)) と同じ Bearer / 同期方式。

## 認証
- service 呼び出し (export / roster): `Authorization: Bearer {service token}`
  (scope `face-template:export`, `roster:read`)。通常は
  `CERNERE_PROJECT_CLIENT_ID` / `CERNERE_PROJECT_CLIENT_SECRET` から都度取得し、
  `CERNERE_SERVICE_TOKEN` は手動確認時の固定Bearer代替としてのみ使う。
- 生徒本人の操作 (同意・撤回): 生徒の access token (kiosk では authCode → `POST /api/auth/code/exchange` で一時取得、保存しない)
- 登録 (PUT template): service token + `enrolledBy` (職員 userId) 必須

## `GET /api/identity/face-template/export?facilityId=`
- res:
  ```jsonc
  { "modelId": "insightface/glintr100@1",
    "templates": [ { "userId", "template": "base64(AES-GCM ct)", "keyId", "modelId", "quality", "version", "enrolledAt", "revoked": false, "state": "active" } ],
    "revoked": [ { "userId", "version" } ] }
  ```
- `template` は Cernere 保存時の暗号文をそのまま返さない: Cernere は保存鍵で復号し、
  **施設ごとの配布鍵** (`OSTIARIUS_TEMPLATE_KEY` と同じ、Infisical で両者に配る) で再暗号化して返す。
  Cernere の保存鍵は Ostiarius に渡らない。
- 全量スナップショット (passkey export と同じ)。`revoked` は直近 30 日分の tombstone。
- facility の在籍者だけを返す (Cernere の organization / facility 所属で絞る)。
- `templates` は `state: "active"` のテンプレートだけを返し、各要素に `state` を必ず含める。
  Ostiarius は状態を確認できないテンプレートも照合キャッシュへ入れない。

## `PUT /api/identity/face-template`
- req: `{ userId, template: base64(float32[512]), modelId, quality, facilityId, enrolledBy, consentId }`
  (転送は TLS、Cernere が保存鍵で暗号化して保存。平文は保存しない)
- res: `{ version }`。`consentId` が有効でなければ 409 `consent_required`。

## `POST /api/auth/code/exchange` (service token)
- req: `{ code }` (生徒が自分で発行した authCode) → res `{ userId, accessToken, expiresIn }`
- 無認可の `POST /api/auth/exchange` と違い **service token 必須**で、**refreshToken を返さない**。
  共有端末である kiosk に 30 日有効な資格情報を残さないため、交換口を分けている。
- authCode は one-time (Cernere が交換時に破棄)。`accessToken` は 15 分。
- kiosk はこの `accessToken` を同意記録にだけ使い、端末へ保存しない。
- Cernere 側の正本: `Cernere/spec/interface/auth-flows.md` 「共通: kiosk 向け限定交換」。

## `POST /api/identity/face-consent` (生徒 token)
- req: `{ policyVersion, facilityId }` → res `{ consentId, at }`
- **Authorization は生徒本人の access token**。同意者は token の主体から決まるため `userId` は送らない
  (Cernere の schema は strict)。service token で同意を代筆させてはならない。
- 同意文は Cernere が `GET /api/identity/face-consent/policy` で返す (version 付き、日本語)。
- 撮り直し承認 (`/identity/review/reenroll/start`) も同意記録を伴うため、生徒の authCode を要求する。

## `DELETE /api/identity/face-template` (生徒 token) — 撤回。テンプレート削除 + tombstone + 同意 `revokedAt`。
## `DELETE /api/identity/face-template/:userId` (service + `enrolledBy`) — 職員による無効化 (理由必須)。

## `GET /api/identity/roster?facilityId=` (service)
- res: `{ users: [ { userId, hint: "K.M. / 42", roles: ["student"] } ] }` — 氏名フルは返さない。

## passkey export の拡張 (既存 `GET /api/auth/passkey/export`)
- 各 credential に `roles: string[]` (Cernere の user roles) と `facilityIds: string[]` を追加。
  Ostiarius は `OSTIARIUS_STAFF_ROLES` と照合して職員 credential を判定する。
- 任意パラメータ `?facilityId=` で在籍者に絞る (未指定は従来通り全件)。

## 保持・削除 (Cernere 側の責務)
- テンプレートは在籍中のみ。organization/facility 離脱、卒業、同意撤回、年次再同意未実施 (同意から 365 日) で削除。
- 削除は物理削除 + tombstone 30 日。バックアップからの復元時も tombstone を優先適用。
- 監査: 登録/削除/export 呼び出しを Cernere 側 audit に残す (誰が・どの施設に・何件)。
