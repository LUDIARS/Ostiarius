# feature: プロフィール顔写真を種にした顔登録 + 名簿表示

生徒が GLab のプロフィールに顔写真を 1 枚出すと、そこから抽出したテンプレートが
**`pending` (出席照合に使えない状態)** で保管される。職員が実機で本人確認して
`active` へ昇格させたときだけ、出席認証に載る。写真そのものは名簿・出席確認画面の
表示に使う。

- 方針: [../plan/biometric-data-policy.md](../plan/biometric-data-policy.md) §1.1 (2026-08-18 の保存方針変更)
- 既存の職員立会い登録: [face-enrollment.md](face-enrollment.md) — こちらは**廃止しない**
- 接点: [../interface/http-identity.md](../interface/http-identity.md)、[../interface/cernere-face-template.md](../interface/cernere-face-template.md)

## 1. なぜ「種」に留めるか

アップロード写真をそのまま出席用テンプレートにすると 3 つ壊れる:

1. **本人性が担保されない** — 他人の写真を登録できる。誰の顔かを機械は判定できない。
2. **提示攻撃が確実に通る** — 同じ写真をかざせば必ず一致する。
3. **保証度が嘘になる** — `assurance: 'high'` はライブ撮影 + 生体性確認を根拠にしている。

そこで写真は **登録の手間を減らす種**としてだけ使い、「この写真の人物が目の前の本人である」
という判断は従来どおり職員が実機で行う。職員の作業は「撮影 5〜8 ショット」から
「画面の写真と目の前の顔を照合して承認」へ軽くなる。**立会いを無くすのではなく短くする。**

## 2. テンプレートの状態

| 状態 | 出席照合 | 作られ方 |
|---|---|---|
| `pending` | **使わない** | プロフィール写真 1 枚から抽出 |
| `active` | 使う | (a) 職員が `pending` を昇格 / (b) 従来の職員立会い enroll ([face-enrollment.md](face-enrollment.md)) |
| `revoked` | 使わない | 撤回・卒業・職員無効化 |

- Ostiarius の施設キャッシュ (roster) に載るのは **`active` だけ**。`pending` は export しない。
  照合器が `pending` を触れないことを、配布経路の側で担保する。
- 1 写真から作る `pending` は品質が落ちる (従来は 5〜8 ショットの平均 + L2 正規化)。
  昇格時に職員が**追加ショットを撮って `active` を作り直す**か、`pending` をそのまま昇格するかを
  選べる。既定は**撮り直し** — 誤拒否を増やさないため。
- 撮り直しは新しい同意記録を伴い、同意は**生徒本人の token でしか記録できない**。承認パネルは
  職員 passkey に加えて**生徒の認証コード**を要求し、`POST /api/auth/code/exchange` で交換した
  本人 token で同意を打つ。交換した userId が審査対象と一致しなければ 409 `student_mismatch`。

## 3. フロー

```
[生徒: GLab プロフィールで顔写真を選択]
  → [同意画面 (policyVersion 付き。保存すること・表示範囲・削除方法を明示)]
  → [GLab → Cernere: 写真を封緘保存 (face_photos) + 抽出要求]
  → [Cernere → 抽出 sidecar: 512d を得る。写真は表示用に保存、抽出フレームは破棄]
  → [face_templates に state=pending で保存 (consentId 紐付け)]
  → [生徒の画面: 「顔認証: 審査待ち」]

[職員: 実機 (kiosk /enroll) で承認]
  → [名簿から pending の生徒を開く → 画面に写真を表示]
  → [目の前の本人と照合 (人間の目)]
  → [承認: 追加ショットを撮って active を作り直す (既定) / 写真由来の pending を昇格]
  → [却下: 写真と pending を同時に削除 + 却下理由を Cernere audit へ]
  → [active になった時点で施設キャッシュへ即時 upsert]
```

- **却下理由は必須**。「他人の写真だった」を検知した記録が残らないと、同じ生徒が
  何度でも出し直せる。却下時は写真も削除し、`pending` だけを残さない。
- 昇格・却下はどちらも職員の passkey 認可 (`staff_override` と同等)。

## 4. 名簿・出席確認画面での表示

- 表示先は **職員の名簿・出席確認画面**と、**本人のプロフィール画面**のみ。kiosk には出さない。
- GLab は写真を保存しない。Cernere の取得 API を**都度**中継し、応答に
  `Cache-Control: private, no-store` を付ける (既存のプラグインプロキシがこれを担保している)。
- 取得は 1 件ずつ。名簿一覧で全員分を一括取得する口は作らない (漏洩時の被害量を絞る)。
- 写真が無い / `pending` の生徒は、顔の代わりに状態バッジ (`未登録` / `審査待ち`) を出す。

## 5. 出席記録に認証方法を残す

現在 GLab は Ostiarius の attestation から `method` / `assurance` を読み落としており、
顔で通っても台帳に `passkey` と記録される (`plugins/attendance/index.ts` の `source: 'passkey'`
ハードコード)。

- GLab 側の `AttestationPayload` に `method` / `assurance` を通し、出席行の `source` に
  実際の方法 (`face` / `face_passive` / `passkey` / `staff_override`) を記録する。
- 既存行は `passkey` のまま残す (遡って書き換えない)。
- 出席一覧の表示も方法別に出し分ける。**どの経路で通ったか分からない出席記録を増やさない。**

## 6. 受け入れ条件

- プロフィール写真から作ったテンプレートは、職員が昇格するまで出席照合に**一切載らない**
  (roster export に `pending` が混ざらないことをテストで担保)。
- 写真の削除がテンプレート (`pending` / `active`) の削除と常に同時に起きる。
- 写真が Ostiarius / GLab のディスク・ログに残らない (`no-biometric-log` lint を写真にも適用)。
- 旧 `policyVersion` の同意しか無い生徒の写真は保存されない。
- 出席台帳に `method` が実際の認証方法で記録される。
