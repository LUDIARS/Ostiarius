# feature: 会場ネットワーク限定の新規登録 (Ostiarius 分)

**Status: Implemented (Ostiarius 側)** (2026-11-06、neco 指示。Cernere 側の API・signup 分岐・登録画面は別タスク)

Actio: `actio:77fe2803-57de-4d17-8c77-0af96637d937`

設計の正本は Cernere `spec/feature/venue-network-registration.md` (Cernere PR #3649) とする。
この文書は、その §10 の Ostiarius の担当分 (受け口・署名・送信・用途の分離・施設 ID) を定める。

関連: [onsite-mfa-factor.md](onsite-mfa-factor.md) (LAN 内の nonce 受け口・Cernere への送信を再利用) /
[lan-https-and-lan-url.md](lan-https-and-lan-url.md) (端末から LAN の Os へ HTTPS) /
[checkin-verification.md](checkin-verification.md) (attestation の形式)

---

## 1. 位置付け

Cernere の新規登録は、Os の会場 LAN に居る端末から行ったときだけ自動で `active` になり、Os の組織の
`member` として登録される。Os は新規登録者の本人確認をしない (顔もパスキーもまだ無い)。Os が保証するのは
**「この nonce が会場 LAN 上の端末から Os へ届いた」こと**だけである。

組織は Cernere の kiosk 登録の `placeId` (= `organizations.id`) で決まり、attestation には組織を載せない。

## 2. フロー (Os の担当部分)

```
[端末 (会場 Wi-Fi)]                        [Ostiarius (会場 LAN)]                 [Cernere]
 POST /api/auth/venue-registration/start ─────────────────────────────────────▶ {challengeId, nonce, kiosks[lanUrl]}
 POST {lanUrl}/api/venue-registration/sessions {nonce} ──▶ LAN 送信元か確認 (外は 403)
                                                          nonce の一回限り確認 (再送は 409)
                                                          purpose:"registration" で署名
                                                          POST /api/auth/venue-registration/attestations ──▶ {accepted:true}
 ◀── 202 {state:"submitted"}
 GET /api/auth/venue-registration/status (Cernere をポーリング) ───────────────▶ verified
```

- 端末が LAN の Os に届かない (会場の外) ときは Os に要求が来ない。端末は Cernere の status が `verified` に
  ならないまま期限切れになり、例外経路 (`pending`) で登録を続けられる (Cernere 側の判断)。
- 現地確認 MFA と違い、kiosk 画面での本人確定の段は無い。受け取った時点で署名して送る。
  同時に複数の端末から受けてよい (MFA の `kiosk_busy` 排他は持たない)。

## 3. 端末向け API

`POST /api/venue-registration/sessions` `{ nonce }`

| 応答 | 意味 |
|---|---|
| `202 { state: "submitted" }` | Cernere が attestation を受理した |
| `400 { error: "bad_request" }` | nonce が 43 文字の base64url でない |
| `403 { error: "lan_required" }` | 送信元が施設 LAN でない (中継ヘッダ付き・公開アドレス) |
| `409 { error: "nonce_reused" }` | 保持期間 (10 分) 内の同じ nonce の再送 |
| `422 { error: <Cernere の拒否コード> }` | `invalid_format` `unknown_kiosk` `revoked_kiosk` `invalid_signature` `purpose_mismatch` `nonce_unknown` `nonce_used` `subject_mismatch` `stale` `assurance_insufficient` `place_not_allowed` `organization_unknown` |
| `502 { error: <Os 側の送信失敗> }` | `service_token_unavailable` `cernere_unreachable` `submit_unauthorized` `submit_failed` `purpose_not_allowed` |

- LAN 判定は現地確認 MFA と同じ `createLanGuard` (`server/face/lan-guard.ts`)。
- CORS は Cernere のログイン画面の origin (`CERNERE_FRONTEND_URL`、未設定なら `CERNERE_BASE_URL` の origin) だけを許可する。
  公開 origin から LAN への fetch に要る Private Network Access の preflight も許可する
  (`server/http-security/private-network-access.ts`、MFA の受け口と共有)。
- 受け取るのは nonce だけ。ほかのフィールドは読まない。
- 接続元ごとのレート制限 (`server/http-security/lan-routes.ts` の RATE_LIMITED_POST) をかける。

## 4. attestation

形式は既存の `base64url(JSON payload) + "." + base64url(Ed25519 署名)` (`server/attestation.ts` の固定順署名)。

```json
{ "sub": null, "placeId": "<OSTIARIUS_FACILITY_ID>", "lanId": "<OSTIARIUS_LAN_ID>", "nonce": "<届いた nonce>",
  "issuedAt": <epoch ms>, "method": "lan", "assurance": "network", "purpose": "registration" }
```

- `sub` は null 固定 (本人確認をしない)。`method` / `assurance` は `lan` / `network` 固定。
- 署名鍵は gateway の Ed25519 鍵 (Cernere の `onsite_kiosks` に登録した公開鍵と対)。
- 署名の型は判別共用体 (`SubjectAttestation` / `RegistrationAttestation`) で、出席・MFA の署名に
  `registration` / `lan` / `network` / `sub: null` を書けない。

## 5. Cernere への送信

`POST {CERNERE_BASE_URL}/api/auth/venue-registration/attestations` `{ attestation }`

- 認可は Os の project token (project client credentials から都度取得)。呼出元 project の `service_scopes` に
  `venue-registration:submit` の宣言が要る (無ければ 403 → `submit_unauthorized`)。
- 送信の共通部は `server/cernere-attestation-submit.ts`。現地確認 MFA (`/api/mfa/onsite/attestations`) と共有し、
  受け口ごとに送ってよい purpose を持つ。違う purpose は送る前に `purpose_not_allowed` で断る。
- 送るのは署名済み attestation だけ。redirect は追わない (Bearer を別 origin へ渡さない)。

## 6. 用途の分離 (出席・MFA で registration を作らない・受け付けない)

| 経路 | 作る purpose | 送る前の検査 |
|---|---|---|
| 出席 (Aedilis `gateway-verify`、`attendance-delivery.ts`) | `attendance` だけ | `attendance` 以外は `ATTESTATION_PURPOSE_NOT_ATTENDANCE` で送らない |
| 出席の再送待ち (`face/aedilis-outbox.ts`) | — | `attendance` 以外は積まない。積まれていた行は送らずに捨てる |
| 現地確認 MFA (`onsite-mfa/cernere-submit.ts`) | `mfa` だけ | `mfa` 以外は `purpose_not_allowed` で送らない |
| 会場登録 (`venue-registration/cernere-submit.ts`) | `registration` だけ | `registration` 以外は `purpose_not_allowed` で送らない |

検査は `server/attestation-purpose-guard.ts` の `foreignAttestationPurpose`。payload を読めない文字列は受け手の
署名検証に任せる。purpose が無い旧形式は `attendance` として読む。

## 7. 施設 ID (`OSTIARIUS_FACILITY_ID`)

- Cernere の組織 UUID (`organizations.id`) を入れる。kiosk 登録の `placeId`、顔の同意・失効の `facilityId`、
  attestation の `placeId` はすべてこの値で揃える。
- UUID でない値 (例: `glab-main`) は**起動時の設定エラー** (`FacilityIdConfigError`) として起動を止める。
  警告で済ませない (`glab-main` のまま動かすと Cernere の face-consents が 400 を返し、同意の記録が止まっていた)。
- 大文字の UUID は小文字に正規化する。

| 拠点 | Cernere | `OSTIARIUS_FACILITY_ID` |
|---|---|---|
| 本社 | `cernere-test` | GLabテスト組織の UUID |
| AWS | `cernere` (本番) | GLab 組織の UUID |

組織の作成と kiosk の登録 (`POST /api/admin/onsite-kiosks`) は Cernere の admin が行う。Os の env 変更は運用者が行う。

## 8. 受け入れ条件 (契約)

- C-10 signAttestation: 固定順で直列化し、purpose を attendance | mfa | registration に限る (registration は sub=null・lan・network)
- C-24 signVenueRegistrationAttestation: 会場登録の payload を固定順・固定値で署名する
- C-25 submitVenueRegistrationAttestation: registration だけを送り、応答を固定語彙へ写す
- C-26 issueVenueRegistration: 同じ nonce は 1 回だけ署名・送信し、Cernere が受理したときだけ accepted
- C-27 foreignAttestationPurpose: 出席・MFA の送信経路で別 purpose (registration を含む) を検出して送らせない
- C-28 resolveFacilityId: UUID だけを受け、UUID でない値は設定エラーで throw する

## 9. 範囲外

- Cernere 側の migration・API・signup 分岐・登録画面・許可待ち一覧 (Cernere のタスク)。
- 各拠点の組織作成・kiosk 登録・Os の env 変更 (admin / 運用者の作業)。
