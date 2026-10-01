# feature: 現地確認 MFA 要素 (onsite factor)

**Status: Draft** (2026-10-01、LLM 作成の設計案。neco 承認前。実装は承認後)

Ostiarius の現在の役割は **所在確認用の副次的認証** である。kiosk での顔認証・パスキーで
「本人がその場に居た」ことを確かめ、Ed25519 attestation を Aedilis の出席記録へ渡す
([identity-verification.md](identity-verification.md))。

この文書は、同じ確認を **Cernere の MFA 要素「現地確認 (onsite)」** としても使えるようにする
設計を定める。Cernere 単体 (パスワード + TOTP / メール) では「その場に本人が居る」ことを
証明できない。現地確認が要る操作だけ、Ostiarius の確認を追加要素として要求する。

関連: [identity-verification.md](identity-verification.md) /
[../plan/face-data-local-only.md](../plan/face-data-local-only.md) /
Cernere `spec/feature/mfa-authenticator.md` (SPEC-MFA-CHALLENGE) /
Corpus `spec/plan/auth-plane-consolidation.md` §5

---

## 1. 位置付け

| | 所在確認 (現行) | 現地確認 MFA (追加) |
|---|---|---|
| 目的 | 出席の記録 (代返耐性) | Cernere の操作に、現地に本人が居ることを追加要素として課す |
| 起点 | 生徒が kiosk に立つ | Cernere が MFA challenge を発行する |
| attestation の受け手 | Aedilis | Cernere |
| 結果 | 出席イベント | challenge の消費 → 元の操作を続行 |

既存の MFA 要素 (TOTP / メール) を置き換えない。現地確認は **場所に縛られた追加要素** で、
要求するかどうかは Cernere 側の操作ごとの方針で決める (§5)。

所在確認と現地確認 MFA は目的が違う。片方の attestation をもう片方に流用させない (§3)。

## 2. フロー

```
[利用者端末]                 [Cernere]                      [kiosk = Ostiarius]
 操作を開始 ───────────────▶ onsite challenge 発行
                             {challengeId, nonce, userId,
                              purpose, mfaRevision, 5 分}
 QR 表示 (nonce のみ) ◀──────
       │ kiosk のカメラ / 職員端末で読む
       └──────────────────────────────────────────────▶ MFA セッション開始 (nonce 束縛)
                                                       顔 1:N + 生体性 (または passkey)
                                                       sub = 照合で確定した利用者
                             ◀──── attestation 送信 ─── {sub, placeId, lanId, nonce, issuedAt,
                                                        method, assurance, purpose:"mfa"}
                             検証 (§4) → challenge 消費
 元の操作を続行 ◀────────────
```

- QR に載せるのは `nonce` だけ。userId や操作内容は載せない (覗き見で情報が漏れない)。
- kiosk は照合で確定した本人を `sub` に入れる。challenge 側の userId とは Cernere が照合する。
  QR を他人に渡しても、kiosk の前に立つ人の顔が challenge の本人でなければ通らない。
- attestation は Ostiarius が Cernere へ直接送る。利用者端末を中継させない。
  送信には Ostiarius の project client credentials から得た scope 付き service token を使う
  (`onsite-mfa:submit`。Corpus 認証集約 P2/P3 の方式に揃える)。

## 3. attestation の用途分離

payload の末尾に `purpose` を追加する (既存 7 フィールドの後、順序固定)。

```jsonc
{ "sub", "placeId", "lanId", "nonce", "issuedAt", "method", "assurance",
  "purpose": "attendance" | "mfa" }
```

- `purpose` が無い attestation は `attendance` とみなす (既存の Aedilis 経路の互換)。
- Aedilis は `purpose: "mfa"` を拒否する。Cernere は `purpose: "mfa"` 以外を拒否する。
- 署名対象は payload 全体なので、`purpose` の書き換えは署名検証で落ちる。

## 4. Cernere 側の検証

SPEC-MFA-CHALLENGE の challenge 管理 (期限・試行回数・一回消費) をそのまま使い、
method に `onsite` を足す。検証項目:

1. 署名: 登録済み Ostiarius gateway の公開鍵で Ed25519 検証 (鍵の登録先は §7 の判断点)。
2. 用途: `purpose == "mfa"`。
3. 束縛: `nonce` が有効な onsite challenge に一致し、`sub` がその challenge の userId と一致する。
4. 鮮度: `issuedAt` が 120 秒以内 (所在確認と同じ)。nonce は一回消費。
5. 確度: `assurance` が操作の要求値以上。`staff_override` (`manual`) は MFA として受理しない。
6. 場所: 操作が場所を指定する場合、`placeId` が許可された施設に含まれる。
7. 設定状態: challenge 発行後に `mfa_revision` が変わっていれば拒否する。

Cernere が受け取るのは attestation だけで、顔画像・テンプレート・スコアは受け取らない
(顔データの正本は Ostiarius ローカル、[../plan/face-data-local-only.md](../plan/face-data-local-only.md))。

## 5. どの操作に要求するか

Cernere の操作方針 (`action-policy`) に「現地確認が必要」「要求する assurance」「許可する施設」を
宣言できるようにする。どの操作を対象にするかは本設計では決めない (§7)。

method と assurance の対応は [identity-verification.md](identity-verification.md) §4 を使う。

| method | assurance | MFA として |
|---|---|---|
| `face` | `high` | 受理 |
| `face_passive` | `medium` | 要求値次第 |
| `passkey` (kiosk 経由) | `medium` | 要求値次第。端末を渡せば代行できるので `high` 要求には足りない |
| `staff_override` | `manual` | 受理しない |
| `session` / `password` | `low` | 受理しない |

## 6. 脅威

| 攻撃 | 対策 | 残余 |
|---|---|---|
| 遠隔の攻撃者が QR を現地の協力者に渡す | `sub` は kiosk の顔照合で決まる。challenge 本人の顔が現地に無ければ通らない | 本人が協力する場合 (MFA の範囲外) |
| attestation の再送 | nonce の一回消費 + 120 秒の鮮度 | — |
| 出席用 attestation の流用 | `purpose` の分離と署名対象への包含 | — |
| 偽 kiosk | 登録済み gateway 鍵でのみ検証 | gateway 鍵の漏えい (ホスト物理侵害) |
| QR の覗き見 | QR は nonce のみ、5 分で失効 | — |

## 7. 判断が要る点 (neco)

- 現地確認を要求する Cernere の操作 (例: 職員権限の変更、施設限定の操作など)。
- challenge の受け渡し: 利用者端末の QR を kiosk で読む方式 (本案) か、kiosk に出るコードを利用者が入力する方式か。
- gateway 公開鍵の登録先: Cernere に新設するか、Aedilis の gateway registry を共有するか。
- kiosk 経由の `passkey` を MFA の要素として数えるか。

## 8. 段階

前段が終わらないと次が動かない順。実装は本設計の承認後に Actio タスクへ分解する。

1. **D0 設計** — 本文書、Cernere 側仕様、Corpus 認証集約 §5 の更新。
2. **O1 Ostiarius** — `purpose` の追加、MFA セッション (nonce 束縛)、Cernere への送信。
3. **C1 Cernere** — `onsite` method、challenge 発行と §4 の検証、gateway 鍵の登録。
4. **C2 Cernere** — `action-policy` への要求宣言。
5. **F1 実機確認** — 2026-10-04 の所在確認の実機テスト (P4) の後に行う。
