# feature: 本人確認ゲート (顔認証 + パスキー) — Ostiarius の役割再設計

**Status: Designed** (2026-08-16、Memoria #1048)

Ostiarius の役割を「会場 LAN 上の出席 API ゲートウェイ」から
**「その場に本人がいることを強固に確認する本人確認ゲート」** へ再定義する。
代返 (他人による出席の肩代わり) への耐性を上げることが目的。

- 主経路: **顔認証 + 生体性確認** (施設に置く kiosk のカメラ、1:N 照合)
- 補助経路: **本人携帯端末のパスキー** (Cernere に登録済み。顔が使えない/誤拒否時)
- 人手経路: **職員 override** (職員本人のパスキー + 理由必須)
- 出力: 従来通り Ed25519 attestation (Aedilis 互換) に `method` / `assurance` を追加

関連: [face-verification.md](face-verification.md) / [face-enrollment.md](face-enrollment.md) /
[passkey-fallback.md](passkey-fallback.md) / [../plan/biometric-data-policy.md](../plan/biometric-data-policy.md) /
[../plan/face-model-selection.md](../plan/face-model-selection.md)

---

## 1. 背景と再設計の理由

| 旧役割 (〜2026-08) | 新役割 |
|---|---|
| PWA から来た passkey assertion を LAN 内でオフライン検証し attestation を返す | **本人がその場にいる**ことを顔 + 生体性で確認し、attestation を返す。パスキーは補助 |
| 施設 LAN 内 HTTPS の証明書発行 (#507 ACME DNS-01) が前提課題 | kiosk は Ostiarius ホスト上のブラウザ (localhost/LAN) で動く。TLS 課題は本再設計で完了扱い、Cloudflare Tunnel を使わない LAN TLS は将来要件が出た時に別扱い |
| 出席の主体は来場者の端末 | 出席の主体は **施設側の kiosk**。来場者端末は補助経路のみ |

パスキーだけでは「端末を渡せば代返できる」。顔認証 + 生体性は「本人の顔がその場に
実在する」ことを求めるので、代返のコストが物理的立会いと同等まで上がる。

## 2. スコープ

### やること
- 生徒の顔テンプレート (embedding) の登録・失効・同期 (写真は保存しない)
- kiosk での 1:N 顔照合 + パッシブ/アクティブ生体性確認
- 本人携帯パスキーによる代替 (Cernere が正本、Ostiarius はオフライン検証キャッシュ)
- 職員 override と監査ログ
- attestation への `method` / `assurance` 付与
- 同意・保持・削除・復旧の仕様化 (plan/biometric-data-policy.md)

### やらないこと
- 学生端末のインカメ selfie を**主経路**にすること (写真提示・代返に弱い。将来のオプション扱い)
- 顔からの属性推定・感情推定・追跡 (Vultus / Ludellus-Native の領分でもなく、Ostiarius では一切やらない)
- 顔写真そのものの保存・閲覧機能 (職員向けサムネイルも持たない)
- Cernere ログインの発行 (Ostiarius は attestation を返すだけ。ログインは Cernere)

## 3. 責務境界 (Ostiarius / Vultus / Cernere / Aedilis)

```
[生徒]──顔──▶ kiosk (Ostiarius host + camera)
                │  face-sidecar: 検出→生体性→embedding→1:N
                │  passkey: LAN 内 assertion 検証 (Cernere export キャッシュ)
                ▼
          attestation {sub, placeId, lanId, nonce, issuedAt, method, assurance}
                │
                ▼
             Aedilis (出席記録・attestation 検証・gateway registry)   ──▶ Memoria (出席イベント)

Cernere: 同意記録 / 顔テンプレート正本 (暗号化 blob) / パスキー正本 / 失効 / export (passkey + face-template)
Vultus : 関与しない (モデル取得・SHA 検証の運用パターンのみ参考)
```

| 責務 | Ostiarius | Cernere | Aedilis | Vultus |
|---|---|---|---|---|
| 顔テンプレート抽出 (enroll) | ○ kiosk で抽出し Cernere へ登録 | 受領・暗号化保存・正本 | — | — |
| 顔テンプレート保持 | キャッシュ (施設単位、sync) | **正本** | — | — |
| 同意・撤回・削除 | 撤回 UI 導線を出す | **記録・執行** (削除 → tombstone export) | — | — |
| 顔照合・生体性判定 | **○** | — | — | — |
| パスキー登録 | kiosk が Cernere パスキー登録ページの QR を表示 | **○** (device-link、#155) | — | — |
| パスキー検証 | ○ (オフライン、export キャッシュ) | 正本・失効 | — | — |
| 職員 override | ○ (職員 passkey で認可) | 職員ロール判定 (export の `roles`) | — | — |
| attestation 署名 | **○** | — | 検証 | — |
| 出席記録 | — | — | **○** | — |
| 監査ログ (画像なし) | ○ ローカル + Aedilis へ要約 | — | 受領 | — |

Vultus とは **モデル・コードを共有しない**。Vultus は「同一人物の類似検索」、Ostiarius は
「roster 数十〜数百人に対する認証用 1:N」で要求 (falseAccept 重視・生体性必須) が異なる。

## 4. 認証手段と assurance

| method | 何を確認するか | assurance | 主/補助 |
|---|---|---|---|
| `face` | 顔 1:N 一致 + パッシブ生体性 + アクティブチャレンジ | `high` | 主 |
| `face_passive` | 顔 1:N 一致 + パッシブ生体性のみ (チャレンジ省略設定時) | `medium` | 主 (設定) |
| `passkey` | 本人携帯の passkey assertion (userVerification required) | `medium` | 補助 |
| `staff_override` | 職員 passkey + 理由 + 対象生徒 ID | `manual` | 人手 |
| `session` | 既存 Cernere セッション (#6、LAN 到達性のみ) | `low` | 互換 (既定 OFF) |
| `password` | email/password (#5) | `low` | 互換 (既定 OFF) |

`session` / `password` は本再設計で **既定無効** (`OSTIARIUS_LEGACY_METHODS` で明示有効化)。
Aedilis 側は `assurance` で受理ポリシーを決められる (例: 出席は `medium` 以上)。

## 5. kiosk フロー (主経路)

```
[待機画面] ─顔検出─▶ [生体性(パッシブ)] ─live─▶ [1:N 照合] ─一致─▶ [チャレンジ: 瞬き/首振り] ─OK─▶ [attestation 発行 → Aedilis へ送信 → 完了表示 (氏名は出さず、イニシャル/学籍下2桁等の弱識別のみ)]
      │                    │ spoof                 │ 不一致/曖昧               │ 失敗
      │                    ▼                        ▼                           ▼
      │              [やり直し (3回まで)] ──▶ [代替: パスキー QR / 職員呼出]
      └ 一定時間顔なし → 待機
```

- 待機画面は Ostiarius が配信する `/kiosk` (同一ホストのブラウザ、`getUserMedia`)。
- フレームは kiosk ブラウザ → Ostiarius `/identity/face/*` → face-sidecar (localhost) の経路。
  ブラウザ側で推論しない (モデルの改ざん・端末差を避ける)。
- attestation の PWA 経由送信は不要。kiosk (= Ostiarius) が **直接 Aedilis へ POST** する
  (`AEDILIS_BASE_URL` 既存設定を流用。到達不能時はローカルキューに積んで再送)。

## 6. attestation 拡張

payload は既存 5 フィールドを維持し末尾に 2 つ追加 (順序固定):

```jsonc
{ "sub", "placeId", "lanId", "nonce", "issuedAt",
  "method": "face" | "face_passive" | "passkey" | "staff_override" | "session" | "password",
  "assurance": "high" | "medium" | "manual" | "low" }
```

旧 Aedilis は未知フィールドを無視して検証できる (署名対象は payload 全体なので互換性は
署名検証で担保)。Aedilis 側の受理ポリシー追加は P3 (Aedilis CONTRACTS §1 追記)。

## 7. 脅威モデル (代返に絞る)

| 攻撃 | 対策 | 残余リスク |
|---|---|---|
| 写真/動画を kiosk に提示 | パッシブ生体性 (MiniFASNet) + アクティブチャレンジ | 高品質 3D マスク。物理監督で補完 |
| 端末を渡してパスキー代返 | パスキーは補助 (`medium`)。Aedilis 側で `passkey` 連続使用に上限/通知 | 顔経路が使えない日は下がる |
| enroll 時に他人の顔を登録 | **職員立会い必須** (kiosk 登録は職員 passkey で開始) | 職員の共謀 |
| テンプレート窃取 → 逆変換 | 写真非保存 / テンプレートは Cernere 側 AES-GCM 暗号化 + Ostiarius キャッシュは DB 暗号化 (SQLCipher 相当) or ホスト暗号化 + キー分離 | ホスト物理侵害 |
| kiosk 改ざん (別 Ostiarius を立てる) | attestation は Aedilis 登録済み公開鍵でのみ検証 (既存 registry) | — |
| 職員 override 濫用 | 理由必須・監査ログ・Aedilis へ通知・日次上限 | — |
| 閾値の緩和 (自動チューニング汚染) | 認証ドメインの閾値は**手動設定のみ**、自動学習は持たない | — |

Ludellus-Native `spec/feature/location-face-auth.md` §5 の指摘 (替え玉はソフト単体で閉じない、
生体データは単一情報源) を前提として継承する。

## 8. 設定 (env 追加)

| key | 役割 | 既定 |
|---|---|---|
| `OSTIARIUS_FACE_SIDECAR_URL` | face-sidecar のベース URL (localhost 固定推奨) | `http://127.0.0.1:17591` |
| `OSTIARIUS_FACE_MATCH_THRESHOLD` | 1:N 受理の cos 類似度 (glintr100 基準) | `0.62` |
| `OSTIARIUS_FACE_MARGIN` | 1 位と 2 位の差の下限 | `0.08` |
| `OSTIARIUS_FACE_CHALLENGE` | `required` / `off` | `required` |
| `OSTIARIUS_LIVENESS_THRESHOLD` | パッシブ生体性スコア下限 | `0.90` |
| `OSTIARIUS_LEGACY_METHODS` | 有効化する互換 method (CSV: `session,password`) | _(空=無効)_ |
| `OSTIARIUS_TEMPLATE_KEY` | ローカルテンプレートキャッシュ暗号化鍵 (secret、Infisical) | **必須 (顔有効時)** |
| `OSTIARIUS_STAFF_ROLES` | override を許す Cernere ロール (CSV) | `staff,admin` |
| `OSTIARIUS_KIOSK_TOKEN` | kiosk 画面/enroll 画面を開くための共有トークン (LAN 内でも他端末から叩けないように)。**同一ホスト (loopback) からの接続はトークン不要** — kiosk は Ostiarius ホスト上のブラウザで動き (§5)、ブラウザはアドレスバーから `x-ostiarius-kiosk` ヘッダを送れないため。プロキシヘッダは見ない | **必須** |

## 9. 実装フェーズ

- P1 パスキー先行 (kiosk 導線 + 登録 QR + attestation 拡張) — [tasks/idv-p1-passkey.md](../tasks/idv-p1-passkey.md)
- P2 顔認証 (sidecar + enroll + verify + liveness + kiosk UI) — [tasks/idv-p2-face.md](../tasks/idv-p2-face.md)
- P3 Cernere / Aedilis 契約 (テンプレート正本・同意・export・受理ポリシー) — [tasks/idv-p3-cernere-aedilis.md](../tasks/idv-p3-cernere-aedilis.md)
- P4 実機確認 — [tasks/idv-p4-field.md](../tasks/idv-p4-field.md)
