# feature: 顔テンプレート登録 (enroll) — 職員立会い + 同意

> **2026-09-12 改訂**: テンプレートの正本は **Ostiarius (施設 kiosk ホスト)**。Cernere へは送らない
> ([../plan/face-data-local-only.md](../plan/face-data-local-only.md))。Cernere に残るのは同意記録と失効指示だけ。

生徒の顔から embedding (テンプレート) を抽出し、**施設の kiosk ホスト内に封緘して保存**する。
プロフィール顔写真 1 枚も同じホストに封緘保存できる (職員の本人確認用、
[face-photo-seeded-enrollment.md](face-photo-seeded-enrollment.md))。全体像は
[identity-verification.md](identity-verification.md)、方針は
[../plan/biometric-data-policy.md](../plan/biometric-data-policy.md)。

- 実装: `server/routes/identity-enroll.ts`、`server/face/enrollment-session.ts`、
  `server/face/local-key.ts` (鍵)、`server/face/local-store.ts` (封緘保存)、kiosk `/enroll` 画面
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
  → [Ostiarius が **ローカル正本**へ封緘保存 (AES-256-GCM、鍵はホスト内生成。state='active')]
  → [次のフレームから照合 roster に載る (同期を待たない)]
  → [完了。撮影フレームはメモリ上で破棄、ディスクに書かない]
```

- 各ショットは `matched`/`no_match` 判定を行わない (登録なので照合しない) が、
  **既登録テンプレートと 0.62 以上一致する別 user がいれば警告** (二重登録・なりすまし検知)。
- 撮影が既定ショット数に満たない場合は登録しない (品質不足で誤拒否が増えるため)。

## 3. 再登録・更新

- 誤拒否が続く生徒は職員立会いで再登録 (同じ user の行を上書きする。旧テンプレートは残さない)。
- モデル更新 (glintr100 → 別モデル) 時はテンプレート非互換。`modelId` を持たせ、
  Ostiarius は自分の sidecar の `modelId` と一致するテンプレートだけを roster に載せる。
  移行期間は両モデルの sidecar を並走させない (運用で再登録日を設ける)。

## 4. 失効

- 生徒本人の撤回 (Cernere プロフィールから)、卒業/退会、職員による無効化 → Cernere が **失効指示**を積み、
  Ostiarius が `GET /api/identity/face-revocations` の pull で受け取って
  **テンプレート・写真・同意の写しを物理削除**する (最長 15 分)。緊急時は
  `POST /identity/admin/sync` で即時同期 (職員認可)。
- kiosk 上での本人削除 (職員立会い) は `DELETE /identity/enroll/registration/:userId`。
  ローカルを即時削除し、Cernere への同意撤回は outbox で再送する。
- 同意から 365 日を過ぎた登録は、Cernere からの指示を待たずに照合から外す (自前判定)。

## 5. 監査

- enroll 1 件ごとに `verification_events` (`kind=enroll`) を記録: 生徒 userId、職員 userId、ショット数、
  平均品質、警告有無。画像・テンプレートは含めない。
