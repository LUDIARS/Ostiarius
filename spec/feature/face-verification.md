# feature: 顔認証 + 生体性確認 (kiosk 1:N)

kiosk のカメラ映像から「登録済み生徒のうち誰か」を 1:N で確定し、写真/動画/マスクの
提示攻撃を弾いた上で attestation を発行する。全体像は [identity-verification.md](identity-verification.md)。

- 実装 (予定): `server/routes/identity-face.ts`、`server/face/matcher.ts`、`server/face/liveness-challenge.ts`、
  `server/face/sidecar-client.ts`、`face-sidecar/` (Python、ONNX Runtime)
- 接点: [../interface/http-identity.md](../interface/http-identity.md)、[../interface/face-sidecar.md](../interface/face-sidecar.md)
- データ: [../data/face-templates.md](../data/face-templates.md)
- モデル選定: [../plan/face-model-selection.md](../plan/face-model-selection.md)

## 1. パイプライン

```
kiosk ブラウザ (getUserMedia, 640x480, ~5fps を JPEG で POST)
  → Ostiarius POST /identity/face/frame            (session ごとに state machine)
      → sidecar POST /v1/analyze  {jpeg}
           Stage A  SCRFD-10G  顔検出 + 5点ランドマーク  (最大顔のみ、他は無視。複数顔なら「1人ずつ」表示)
           Stage B  品質ゲート  顔幅>=112px / ぼけ / |yaw|<=25° / |pitch|<=20°
           Stage C  MiniFASNetV2 パッシブ生体性 (score)
           Stage D  5点アライン → ArcFace glintr100 512d (L2 正規化)
           Stage E  (チャレンジ中のみ) MediaPipe Face Landmarker blendshapes: eyeBlinkLeft/Right, 頭部 yaw
      → matcher: roster (施設キャッシュ) との cos 類似度、top1 / top2
      → 判定 (§2) → チャレンジ (§3) → attestation
```

sidecar は **localhost のみ listen**。Ostiarius 以外から叩けない。

## 2. 判定ルール (認証ドメイン: falseAccept を falseReject より重く)

| 条件 | 結果 |
|---|---|
| liveness < `OSTIARIUS_LIVENESS_THRESHOLD` (0.90) が連続 3 フレーム | `spoof_suspected` → やり直し。3 回で代替経路へ |
| top1 < `OSTIARIUS_FACE_MATCH_THRESHOLD` (0.62) | `no_match` (未登録 or 別人)。案内: 登録 or パスキー |
| top1 >= 閾値 かつ top1 - top2 < `OSTIARIUS_FACE_MARGIN` (0.08) | `ambiguous`。追加フレームで再評価 (最大 10 フレーム)。解けなければ代替経路 |
| top1 >= 閾値 かつ margin OK が **連続 3 フレーム同一 user** | `matched` → チャレンジへ |

- 閾値の既定値は glintr100 (cos 類似度) 前提の初期値。P4 の実機データで施設ごとに調整するが、
  **自動チューニングは持たない** (identity-verification.md §7)。
- 複数フレームの「投票」は Ludellus-Native `face-identity.md` の時間投票を簡略化したもの
  (勝者連続 3 票)。

## 3. アクティブチャレンジ (生体性、`OSTIARIUS_FACE_CHALLENGE=required` 時)

`matched` 後に **ランダム 1 種**を要求、8 秒以内:

| challenge | 判定 (blendshapes / 姿勢) |
|---|---|
| `blink` | eyeBlinkLeft & Right が 0.5 を超えて 0.2 未満に戻る (1 回) |
| `turn_left` / `turn_right` | yaw が ±15° を超えて 0 付近に戻る |
| `nod` | pitch が -12° を超えて戻る |

チャレンジ中も **同一 user の一致が維持される**こと (差し替え防止)。成功で `method=face`、
`OSTIARIUS_FACE_CHALLENGE=off` の施設は `method=face_passive` (assurance `medium`)。

## 4. セッション state machine

```
idle ──face detected──▶ scanning ──matched──▶ challenging ──ok──▶ issued ──▶ idle
  ▲        │ no face 5s      │ spoof x3 / no_match / ambiguous timeout    │ timeout 8s
  └────────┘                 └──────────▶ fallback (passkey QR / staff) ◀─┘
```

- session id は kiosk が `POST /identity/face/session` で取得、TTL 60 秒、フレームごとに延長。
- `issued` は attestation を返す前に `verification_events` へ記録 (画像なし)。

## 5. 出力

`issued` で `signAttestation({ sub, placeId, lanId, nonce: sessionId, issuedAt, method, assurance })`。
kiosk は attestation を Aedilis へ送るのではなく、Ostiarius が **`POST {AEDILIS_BASE_URL}/api/checkin/gateway-verify`**
へ直接送信し、失敗時は `outbox` テーブルに積んで再送。既存 `POST /api/checkin/verify` は
**生徒本人の Cernere token** を要求し `sub` 一致を検証する (`Aedilis/server/checkin/service.ts`) ため
kiosk からは使えない。`gateway-verify` は P3 で Aedilis に追加する: 認証は登録済み gateway 公開鍵による
attestation 署名検証 + `Authorization: Bearer {AEDILIS_GATEWAY_TOKEN}` (gateway 登録時に払い出し)。
P3 完了までは outbox に滞留する (P2 の受入は outbox 送信をモックで確認)。

## 6. 表示上の配慮

- 完了画面に氏名を出さない (弱識別: イニシャル + 学籍番号下 2 桁)。他の生徒に見える画面のため。
- 失敗理由は `spoof_suspected` を利用者に見せない (「もう一度お願いします」)。監査ログにのみ残す。

## 7. 性能目標 (Raspberry Pi 5 / 会場 PC)

- SCRFD-10G + glintr100 で 1 フレーム 150〜400ms (CPU, ONNX Runtime)。5fps 入力に対し sidecar は
  最新フレームだけ処理 (キュー長 1、古いフレームは捨てる)。
- 待機中は 1fps に落として省電力 (kiosk 側で制御)。
