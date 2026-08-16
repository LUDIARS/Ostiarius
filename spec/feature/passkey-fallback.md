# feature: パスキー代替経路 + 職員 override

顔認証が使えない (未登録・誤拒否・カメラ故障・生体性チャレンジ不可) ときの補助経路。
認証主体は **Cernere** (パスキーの正本・登録・失効)。Ostiarius は既存の
[checkin-verification.md](checkin-verification.md) (オフライン assertion 検証) をそのまま
検証エンジンとして使い、kiosk 導線と `method` 付与を足す。

## 1. 生徒端末パスキーの登録 (Cernere が主体、Ostiarius は QR を出すだけ)

Cernere の実装 (`server/src/http/passkey-handler.ts`) に合わせて 2 経路。**既定は (a)**。

**(a) 直接登録 (最初のパスキー)** — Cernere `register-begin` は最初の passkey を step-up 無しで
許す (bootstrap)。生徒は **自分のスマホ**で Cernere にログイン (email/password 等) し、
プロフィールからパスキーを追加する。kiosk は `{CERNERE_FRONTEND_URL}/profile#passkey` の QR を
出すだけ。Ostiarius は Cernere API を呼ばない。

**(b) device-link (2 台目以降)** — Cernere `POST /api/auth/passkey/device-link` は
**step-up proof (actionProof) が必須**。既にパスキーを持つ端末でのみ発行できるので、
kiosk 経由ではなく生徒本人の既存端末から発行する (Cernere `/profile` の「他の端末を追加」)。
kiosk が代理発行することはしない (生徒の bearer を kiosk が扱う面を増やさない)。

```
[kiosk: 顔失敗 or 「パスキーで」タップ] → [端末未登録なら QR (a) を表示、案内]
  → [生徒がスマホで Cernere にログイン → パスキー追加 (端末生体認証)]
  → [Ostiarius は次回 sync (or 職員の即時 sync) で公開鍵を取得] → §2 へ
```

## 2. 認証 (LAN 内オフライン検証)

既存 `POST /checkin/begin` / `POST /checkin/finish` を **`/identity/passkey/begin|finish`** に
別名マウントし (旧パスは互換維持)、finish 成功時の attestation に `method=passkey` /
`assurance=medium` を付ける。

kiosk 導線: kiosk が「パスキー用 QR」(`{OSTIARIUS_PWA_ORIGIN}/checkin?nonce=...`) を出し、
生徒は自分の端末 (会場 Wi-Fi 接続済み) で開いて assertion。既存 PWA 画面を流用。
`nonce` は kiosk session と紐づけ、完了を kiosk 画面に反映する (`GET /identity/session/:id`)。

RP ID / origin の制約 (Cernere と同一 eTLD+1) は従来通り ([../interface/cernere-passkey-export.md](../interface/cernere-passkey-export.md))。

## 3. 職員 override (人手経路)

- 職員が kiosk で自分のパスキーで認証 (`/identity/staff/begin|finish`、export の `roles` に
  `OSTIARIUS_STAFF_ROLES` のいずれかを含む credential のみ受理)。
- 対象生徒 (Cernere user id を名簿検索で選択) と **理由 (必須、選択式 + 自由記述)** を入力。
- attestation `method=staff_override` / `assurance=manual`、payload `sub` は生徒、
  `verification_events` に職員 userId と理由を記録。Aedilis へは通常送信 + 日次件数を通知。
- 1 職員あたり日次上限 (`OSTIARIUS_STAFF_OVERRIDE_DAILY_LIMIT`、既定 20)。

Cernere export に `roles` を含めることは P3 で追加 ([../interface/cernere-passkey-export.md](../interface/cernere-passkey-export.md) 改定)。
それまでは `OSTIARIUS_STAFF_USER_IDS` (CSV) で暫定指定。

## 4. 端末紛失・パスキー失効

- 生徒が Cernere プロフィールで該当パスキーを削除 (または職員が Cernere admin で失効) →
  export から消える → Ostiarius sync で削除。緊急は職員の即時 sync。
- 新端末は §1 を再実行。

## 5. 互換 method (`session` / `password`)

#5 (`/checkin/mobile/*`) と #6 (`/checkin/session`) は残すが **既定無効**。
`OSTIARIUS_LEGACY_METHODS=session,password` で明示有効化した施設のみ動き、attestation に
`method` / `assurance=low` を付ける。
