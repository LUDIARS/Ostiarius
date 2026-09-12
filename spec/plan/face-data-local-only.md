# plan: 顔データの保存先を Ostiarius ローカルに限定する (2026-09-12 方針変更)

**Status: Designed** (2026-09-12、neco 裁定)。実装タスクは未分解。

顔テンプレートと顔写真の **正本を Cernere から Ostiarius (施設 kiosk ホスト) へ移し、
生体情報を施設外へ一切出さない**。「絶対ローカルで持つ」が要件。

- 変更前: Cernere が正本 (`face_templates` / `face_photos`、AES-256-GCM)、Ostiarius は 15 分同期の施設キャッシュ
- 変更後: Ostiarius が正本 (施設単位、暗号化 SQLite)、Cernere は **同意記録と失効指示だけ**を持つ

関連: [biometric-data-policy.md](biometric-data-policy.md) (保存範囲表を本方針で改訂) /
[../feature/identity-verification.md](../feature/identity-verification.md) §3 /
[../interface/cernere-face-template.md](../interface/cernere-face-template.md) (旧契約、本方針で縮退) /
[../feature/face-photo-seeded-enrollment.md](../feature/face-photo-seeded-enrollment.md)

---

## 1. なぜ変えるか

- 顔特徴データは個人識別符号で、漏洩時に取り消せない。クラウド (Cernere) に正本を置く限り、
  Cernere の侵害・誤設定・バックアップ流出がそのまま全施設の生体情報流出になる。
- 照合は最初から Ostiarius が施設内で完結している。正本を Cernere に置く理由は
  「施設間配布」「職員が施設外から名簿の顔を見る」「Cernere 側で撤回を即時執行する」の 3 つだけで、
  いずれもローカル保持でも代替できる (§4)。
- Ostiarius はもともとオフライン設計 (Cernere 不通でも照合継続)。正本を持たせても運用像は変わらない。

## 2. 保存範囲 (改訂後)

| データ | Ostiarius | Cernere | Aedilis | GLab |
|---|---|---|---|---|
| 照合 / enroll のフレーム | 持たない (メモリ処理のみ) | 持たない | 持たない | 持たない |
| 顔テンプレート (512d) | **正本** (施設単位、AES-GCM 封緘) | **持たない** | 持たない | 持たない |
| プロフィール顔写真 (1 枚) | **正本** (AES-GCM 封緘、鍵 ID をテンプレートと分ける) | **持たない** | 持たない | 持たない (表示は LAN 内の Ostiarius から都度取得、no-store) |
| 同意記録 (policyVersion, at, facility, 経路) | 写し (照合可否の判定用) | **正本** | — | — |
| 失効指示 (userId, facilityId, reason, at) | 受領して執行 | **正本** (30 日保持) | — | — |
| パスキー公開鍵 | キャッシュ | 正本 | — | — |
| 監査ログ (数値のみ) | ○ 90 日 | 同意・失効の audit のみ | 要約 | — |

Cernere の `face_templates` / `face_photos` (migration 041 / 045) と、それを扱う API
(`PUT/GET/DELETE /api/identity/face-template*`、`/api/identity/face-photo/*`、promote / reject) は
**撤去**する。残すのは `POST /api/identity/face-consent`、`GET /api/identity/face-consent/policy`、
`GET /api/identity/roster`、passkey export の `roles` / `facilityIds` 拡張、
`POST /api/auth/code/exchange`。

## 3. 鍵の置き場

「絶対ローカル」を鍵にも適用する。

- テンプレート鍵・写真鍵は **kiosk ホストで生成し、ホスト外へ出さない**。Infisical に置かない
  (`OSTIARIUS_TEMPLATE_KEY` の Infisical 配布と Cernere 側 `FACE_TEMPLATE_DISTRIBUTION_KEYS` は廃止)。
- 保存先は優先順に TPM 封緘 → OS 資格情報ストア → `OSTIARIUS_DATA` 配下の 0600 鍵ファイル。
  鍵ファイルはホストのディスク暗号化 (BitLocker / LUKS) を必須条件とする。
- 鍵の喪失 = 全登録の喪失と割り切る (再登録で復旧)。鍵のクラウドエスクローは作らない。
- attestation 署名鍵 (`OSTIARIUS_PRIVATE_KEY`) は生体情報ではないので従来通り Infisical 可。

## 4. Cernere 正本で得ていたものの代替

| 旧正本で得ていたもの | 代替 |
|---|---|
| 施設間でのテンプレート配布 | **しない**。別施設では再 enroll。組織単位の共有 (旧 P3 未決) は要件から外す |
| 職員が施設外 (GLab) から名簿の顔写真を見る | **LAN 内に限定**。職員画面は Ostiarius の `GET /identity/face-photo/:userId` を LAN 経由で叩く。施設外表示は要件から外す |
| 本人が Cernere プロフィールから撤回 → 即時削除 | Cernere は **失効指示**を積む (`face_revocations`)。Ostiarius が sync (15 分、職員の即時 sync あり) で pull して物理削除。tombstone の向きが逆になるだけ |
| 卒業・所属離脱・365 日再同意なしでの自動削除 | Cernere が同じトリガで失効指示を積む。Ostiarius は同意の写しでも 365 日超過を自前判定して照合から外す (Cernere 不通時の保険) |
| GLab プロフィール写真からの pending テンプレート | 写真のアップロード先を **kiosk /enroll (LAN 内)** に移す。GLab からのアップロード経路は廃止。pending → active の職員承認フローはそのまま |
| Cernere 側のバックアップ | **施設内の暗号化バックアップ**を標準運用にする (§5) |

## 5. バックアップと機器故障

- 日次で `OSTIARIUS_DATA` の暗号化 DB を施設内媒体 (USB / NAS) へコピーする。バックアップは
  DB と同じ鍵で封緘されているので、鍵ファイルは**別媒体**に保管する (DB と鍵を同じ USB に置かない)。
- 復元時は Cernere の失効指示 30 日分を先に適用してから照合を再開する (削除済みの人物を復活させない)。
- ホスト全損 + バックアップなしは全員再登録。誤拒否時の一次対応はパスキー経路で変わらない。

## 6. 移行

1. Ostiarius: 施設キャッシュ (`face_templates` 相当) を正本テーブルへ昇格。`state` (pending/active/revoked) と
   写真列を追加、鍵をローカル生成に切替。Cernere export 同期を「失効指示 + 同意の pull」に置換。
2. Cernere: 既存テンプレート・写真を **export せずに削除**する (施設配布鍵での再暗号化 export を最後に
   1 回流して Ostiarius に取り込ませる案は、鍵が Infisical 経由になるので採らない)。既登録者は
   kiosk で再 enroll。migration で 041 / 045 のテーブルを drop、鍵 env を撤去。
3. 同意文 `policyVersion` を上げる。「保存先は施設の kiosk 端末のみ、施設外へ出さない」を明記し、再同意を求める。
4. `Cernere/spec/feature/face-template-store.md` は撤去予定として残し、実装削除の PR で削除する。

## 7. 引き受けるリスク

- 施設ごとに正本が分かれるので、多施設に通う生徒は施設ごとに enroll する。
- kiosk ホストの物理侵害で当該施設の全テンプレート・写真が晒される (暗号化と鍵分離で下げる。
  Cernere 侵害で全施設が晒される旧リスクより範囲は狭い)。
- バックアップ運用が施設任せになる。怠ると故障時に全員再登録。

## 8. 未決事項

- TPM 封緘の実装可否 (Raspberry Pi 系ホストは TPM が無い。鍵ファイル + ディスク暗号化で妥協するか)。
- 保護者同意の記録 (旧方針から持ち越し)。
