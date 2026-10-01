# feature: 現地確認 MFA 要素 (onsite factor)

**Status: Designed** (2026-10-01。LLM 作成の設計案に、同日 neco が判断点 4 つを決定。実装は未着手)

Ostiarius の現在の役割は **所在確認用の副次的認証** である。kiosk での顔認証・パスキーで
「本人がその場に居た」ことを確かめ、Ed25519 attestation を Aedilis の出席記録へ渡す
([identity-verification.md](identity-verification.md))。

この文書は、同じ確認を **Cernere の MFA 要素「現地確認 (onsite)」** としても使えるようにする
設計を定める。Cernere 単体 (パスワード + TOTP / メール) では「その場に本人が居る」ことを
証明できない。現地確認が要る操作だけ、Ostiarius の確認を追加要素として要求する。

関連: [identity-verification.md](identity-verification.md) /
[lan-https-and-lan-url.md](lan-https-and-lan-url.md) /
[../plan/face-data-local-only.md](../plan/face-data-local-only.md) /
Cernere `spec/feature/mfa-authenticator.md` (SPEC-MFA-CHALLENGE / SPEC-MFA-ONSITE) /
Corpus `spec/plan/auth-plane-consolidation.md` §5.1

---

## 0. 決定事項 (2026-10-01、neco)

| 論点 | 決定 |
|---|---|
| 現地確認を要求する操作 | 確認を要求するサービス側の設定で決まり、自動で要求される (§5) |
| challenge の受け渡し | 利用者の端末と kiosk の **LAN 内通信**で行う。QR は使わない (§2) |
| 貸し出し用途の代替 | QR が備品の貸し出しの意味を持つ場面では、貸し出した備品のスクリーンショットを LLM で解析して代用する (QR フリー、§2.2) |
| kiosk 公開鍵の登録先 | **Cernere が持つ** (§4.1) |
| kiosk 経由のパスキー | **MFA の要素に数える** (§5) |

## 1. 位置付け

| | 所在確認 (現行) | 現地確認 MFA (追加) |
|---|---|---|
| 目的 | 出席の記録 (代返耐性) | Cernere の操作に、現地に本人が居ることを追加要素として課す |
| 起点 | 生徒が kiosk に立つ | Cernere が MFA challenge を発行する |
| attestation の受け手 | Aedilis | Cernere |
| 結果 | 出席イベント | challenge の消費 → 元の操作を続行 |

既存の MFA 要素 (TOTP / メール) を置き換えない。現地確認は **場所に縛られた追加要素** である。

所在確認と現地確認 MFA は目的が違う。片方の attestation をもう片方に流用させない (§3)。

## 2. フロー

### 2.1 LAN 内通信で challenge を渡す (主経路)

```
[利用者端末]                    [Cernere]                     [kiosk = Ostiarius]
 操作を開始 ──────────────────▶ onsite challenge 発行
                                {challengeId, nonce, userId,
                                 purpose, mfaRevision, 5 分}
 nonce を受け取る ◀────────────
 施設 LAN 上の Ostiarius へ
 nonce を送る (LAN 内通信) ─────────────────────────────────▶ MFA セッション開始 (nonce 束縛)
                                                             kiosk 画面に「確認待ち」を出す
                                                             顔 1:N + 生体性、または passkey
                                                             sub = 照合で確定した利用者
                                ◀──── attestation 送信 ───── {sub, placeId, lanId, nonce, issuedAt,
                                                              method, assurance, purpose:"mfa"}
                                検証 (§4) → challenge 消費
 元の操作を続行 ◀───────────────
```

- 利用者端末から Ostiarius へは、施設 LAN 上の Ostiarius の URL
  ([lan-https-and-lan-url.md](lan-https-and-lan-url.md)) で届ける。LAN の外から nonce を送れないことが、
  現地に居ることの最初の条件になる。
- 端末が送るのは nonce だけ。userId や操作内容は送らない。
- kiosk は照合で確定した本人を `sub` に入れる。challenge 側の userId とは Cernere が照合する。
  nonce を他人に渡しても、kiosk の前に立つ人の顔 (またはパスキー) が challenge の本人でなければ通らない。
- attestation は Ostiarius が Cernere へ直接送る。利用者端末を中継させない。
  送信には Ostiarius の project client credentials から得た scope 付き service token を使う
  (`onsite-mfa:submit`。Corpus 認証集約 P2/P3 の方式に揃える)。
- 同じ kiosk に複数の利用者が同時に nonce を送った場合の扱い (待ち行列にするか、
  端末側で kiosk を選ばせるか) は実装時に決める。

### 2.2 備品の貸し出しでの代替 (QR フリー)

QR が「備品を貸し出した」ことの受け渡しを意味する場面では、QR を使わず、
貸し出した備品のスクリーンショットを LLM で解析して代用する。
本書の MFA フロー (§2.1) とは別の用途で、詳細設計は未着手。着手時に、解析結果をどの
確度として扱うか、画像の保存範囲 (顔が写り込む場合の扱いを含む) を決める。

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
method に `onsite` を足す。

### 4.1 kiosk 公開鍵

kiosk (Ostiarius gateway) の Ed25519 公開鍵は **Cernere が持つ**。施設 (`placeId`) ごとに登録し、
失効できるようにする。Aedilis の gateway registry とは共有しない (Aedilis は出席用の検証で引き続き自前の
registry を使う)。

### 4.2 検証項目

1. 署名: Cernere に登録済みの kiosk 公開鍵で Ed25519 検証。
2. 用途: `purpose == "mfa"`。
3. 束縛: `nonce` が有効な onsite challenge に一致し、`sub` がその challenge の userId と一致する。
4. 鮮度: `issuedAt` が 120 秒以内 (所在確認と同じ)。nonce は一回消費。
5. 確度: `assurance` が要求値以上。`staff_override` (`manual`) は MFA として受理しない。
6. 場所: 要求に施設の指定がある場合、`placeId` が許可された施設に含まれる。
7. 設定状態: challenge 発行後に `mfa_revision` が変わっていれば拒否する。

Cernere が受け取るのは attestation だけで、顔画像・テンプレート・スコアは受け取らない
(顔データの正本は Ostiarius ローカル、[../plan/face-data-local-only.md](../plan/face-data-local-only.md))。

## 5. 要求の決め方

現地確認を要求するかどうかは、**確認を要求するサービス側の設定**で決まる。サービスが
自分の設定 (Cernere の managed project の宣言) に「現地確認が必要」「要求する assurance」
「許可する施設」を持ち、Cernere はそのサービスのログイン・操作のときに自動で onsite challenge を出す。
利用者や Cernere の管理者が操作ごとに指定するものではない。

method と assurance の対応は [identity-verification.md](identity-verification.md) §4 を使う。

| method | assurance | MFA として |
|---|---|---|
| `face` | `high` | 受理 |
| `face_passive` | `medium` | 要求値次第 |
| `passkey` (kiosk 経由) | `medium` | **受理する** (要求値が `medium` 以下の場合)。LAN 内通信を経ているので場所の条件は満たす |
| `staff_override` | `manual` | 受理しない |
| `session` / `password` | `low` | 受理しない |

## 6. 脅威

| 攻撃 | 対策 | 残余 |
|---|---|---|
| 遠隔の攻撃者が nonce を現地の協力者に渡す | `sub` は kiosk の照合で決まる。challenge 本人の顔・パスキーが現地に無ければ通らない | 本人が協力する場合 (MFA の範囲外) |
| LAN の外から nonce を送る | Ostiarius の受け口を施設 LAN 上に限る | LAN への不正接続 |
| attestation の再送 | nonce の一回消費 + 120 秒の鮮度 | — |
| 出席用 attestation の流用 | `purpose` の分離と署名対象への包含 | — |
| 偽 kiosk | Cernere に登録済みの kiosk 鍵でのみ検証 | kiosk 鍵の漏えい (ホスト物理侵害) |
| 端末を渡してパスキーで代行 | パスキーは `medium`。`high` を要求するサービスでは顔が必要 | `medium` 要求のサービスでは残る |

## 7. 段階

前段が終わらないと次が動かない順。実装は Actio タスクへ分解して進める。

1. **D0 設計** — 本文書 (決定済み)、Cernere SPEC-MFA-ONSITE、Corpus 認証集約 §5.1。
2. **C1 Cernere** — kiosk 公開鍵の登録・失効、`onsite` method、challenge 発行と §4.2 の検証。
3. **C2 Cernere** — サービス設定 (managed project の宣言) からの自動要求。Corpus 認証集約 P3 の
   宣言 (`service_scopes`) と同じ管理者所有フィールドの扱いに揃える。
4. **O1 Ostiarius** — `purpose` の追加、LAN 内の nonce 受け口、MFA セッション、Cernere への送信。
5. **F1 実機確認** — 2026-10-04 の所在確認の実機テスト (P4) の後に行う。
