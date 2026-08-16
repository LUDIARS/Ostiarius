# feature: 顔テンプレート登録 (enroll) — 職員立会い + 同意

生徒の顔を **写真として保存せず**、embedding (テンプレート) だけを抽出して Cernere に
正本登録し、Ostiarius は施設単位でキャッシュする。全体像は [identity-verification.md](identity-verification.md)、
方針は [../plan/biometric-data-policy.md](../plan/biometric-data-policy.md)。

- 実装 (予定): `server/routes/identity-enroll.ts`、`server/face/enroll-session.ts`、kiosk `/enroll` 画面
- 接点: [../interface/http-identity.md](../interface/http-identity.md)、[../interface/cernere-face-template.md](../interface/cernere-face-template.md)

## 1. 前提 (運用要件)

- **職員の立会いが必須**。enroll 画面は職員が自分のパスキーで開く (`staff_override` と同じ認可)。
  Ludellus-Native `location-face-auth.md` §5-5 の指摘 (登録時なりすましはソフトで防げない) による。
- 生徒本人の **同意** を取ってからでないと抽出しない。同意は Cernere に記録される (policy version 付き)。
- 生徒の特定は Cernere user id で行う。kiosk 上での本人特定は
  (a) 生徒本人の Cernere ログイン (kiosk 上で composite login → authCode) または
  (b) 職員が名簿から選択 + 学生証目視、のどちらか。**(a) を既定**、(b) は職員 2 名確認を要求。

## 2. フロー

```
[職員 passkey で /enroll を開く]
  → [生徒を特定: 生徒本人が kiosk で Cernere ログイン (authCode → Ostiarius が Cernere で user を確定)]
  → [同意画面: 目的・保存範囲・保持期間・撤回方法を表示 → 生徒が同意 (タップ)]
  → [撮影: 正面 / 左 15° / 右 15° / 眼鏡ありなし など 5〜8 ショット、各ショットで品質ゲート + 生体性]
  → [sidecar が各ショットの 512d を返す → Ostiarius が平均 → L2 正規化 = 代表テンプレート]
  → [Cernere PUT /api/identity/face-template  {userId, template(base64), modelId, quality, consent{policyVersion, at}, enrolledBy(staff userId), facilityId}]
  → [成功で Ostiarius ローカルキャッシュへ即時 upsert (次回 sync を待たない)]
  → [完了。撮影フレームはメモリ上で破棄、ディスクに書かない]
```

- 各ショットは `matched`/`no_match` 判定を行わない (登録なので照合しない) が、
  **既登録テンプレートと 0.62 以上一致する別 user がいれば警告** (二重登録・なりすまし検知)。
- 撮影が既定ショット数に満たない場合は登録しない (品質不足で誤拒否が増えるため)。

## 3. 再登録・更新

- 誤拒否が続く生徒は職員立会いで再登録 (旧テンプレートは Cernere 側で `superseded`)。
- モデル更新 (glintr100 → 別モデル) 時はテンプレート非互換。`modelId` を持たせ、
  Ostiarius は自分の sidecar の `modelId` と一致するテンプレートだけを roster に載せる。
  移行期間は両モデルの sidecar を並走させない (運用で再登録日を設ける)。

## 4. 失効

- 生徒本人の撤回 (Cernere プロフィールから)、卒業/退会、職員による無効化 → Cernere が `revokedAt` を立て、
  export に tombstone として出す → Ostiarius は次回 sync で削除 (最長 15 分)。緊急時は
  `POST /identity/admin/sync` で即時同期 (職員認可)。

## 5. 監査

- enroll 1 件ごとに `verification_events` (`kind=enroll`) を記録: 生徒 userId、職員 userId、ショット数、
  平均品質、警告有無。画像・テンプレートは含めない。
