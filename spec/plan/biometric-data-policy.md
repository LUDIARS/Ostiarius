# plan: 生体情報の取扱い方針 (保存範囲・保持・削除・同意・アクセス制御・復旧)

Memoria #1048 完了条件「顔写真・生体情報の保存範囲、保持期間、削除、同意、アクセス制御を仕様化」
「誤認識・なりすまし・端末紛失時の復旧および人手確認フロー」の正本。

## 1. 保存範囲 (何を持ち、何を持たないか)

| データ | Ostiarius | Cernere | Aedilis | 備考 |
|---|---|---|---|---|
| 顔写真 / 動画フレーム | **持たない** (メモリ処理のみ、ログ・ディスク書き込み禁止) | **持たない** | 持たない | enroll のショットも破棄 |
| 顔テンプレート (512d) | 施設キャッシュ (AES-GCM、鍵は Infisical) | 正本 (保存鍵で暗号化、施設配布鍵で再暗号化して export) | 持たない | 逆変換リスクを暗号化 + 分離で下げる |
| ランドマーク / blendshapes | 持たない (判定後破棄) | — | — | チャレンジ判定の一時値 |
| 生体性スコア / 一致スコア | 監査ログに数値のみ (失敗行は user 無し) | — | 要約のみ (件数) | |
| パスキー公開鍵 | キャッシュ | 正本 | — | 既存 |
| 同意記録 | 持たない | 正本 (policyVersion, at, facility) | — | |
| 出席記録 | 持たない | — | 正本 | attestation 経由 |
| 氏名フル | 持たない (弱識別 hint のみ) | 正本 | 既存通り | kiosk 画面に出さない |

## 2. 保持期間

| データ | 期間 | 削除トリガ |
|---|---|---|
| テンプレート (Cernere) | 在籍中、同意から 365 日で再同意 | 卒業/退会/所属離脱、撤回、再同意なし、職員無効化 |
| テンプレート (Ostiarius キャッシュ) | 次回 sync まで (≤ 15 分) | Cernere export の tombstone / 不在 |
| 監査ログ (Ostiarius) | 90 日 | 日次ローテート |
| outbox | 送信成功まで、最大 7 日 | 送信成功 / 期限 |
| kiosk セッション状態 | 60 秒 | TTL |

## 3. 削除

- 生徒本人: Cernere プロフィール「顔認証の登録を削除」→ 即時削除 + tombstone。Ostiarius へは
  次回 sync (最長 15 分)。kiosk 上での「今すぐ反映」は職員の即時 sync。
- 職員: 誤登録・なりすまし疑い時に無効化 (理由必須、Cernere audit)。
- 削除後の再登録は enroll をやり直す (旧テンプレートは復元しない)。
- バックアップ復元時は tombstone 優先で再削除。

## 4. 同意

- 抽出前に **必ず** 同意画面 (目的・保存するもの/しないもの・保持期間・撤回方法・問い合わせ先) を表示し、
  生徒本人がタップ。同意文は Cernere が version 管理し、変更時は再同意。
- 未成年 (高校生等) を含む施設は保護者同意の運用を施設側で行い、`consent.policyVersion` に
  施設ポリシー ID を含める (システムは記録のみ、判定は施設運用)。
- 同意しない生徒は **パスキー経路のみ**で出席できる (不利益を最小化)。

## 5. アクセス制御

- kiosk / enroll 画面: `OSTIARIUS_KIOSK_TOKEN` (端末に設定) + 職員操作は職員 passkey。
- テンプレート export: Cernere service token に scope `face-template:export` + facility 制限。
- Ostiarius DB: テンプレート列は暗号化、鍵は環境 (Infisical) 経由で平文保存しない。
- sidecar: localhost のみ。管理 API (`/identity/admin/*`) は職員セッション必須。
- ログ: 画像・テンプレート・氏名を出力しない lint (`test/no-biometric-log.test.ts` で文字列検査)。

## 6. 復旧・人手確認フロー

| 事象 | 一次対応 | 二次対応 | 記録 |
|---|---|---|---|
| 誤拒否 (本人なのに no_match/ambiguous) | やり直し 3 回 → パスキー経路 | 職員 override → 後日再登録 | `no_match` 件数を施設別に週次で見る |
| 誤受理の疑い (別人で issued) | 職員が Aedilis 出席を取消 + Ostiarius で該当テンプレート無効化 | 両者を職員立会いで再登録、閾値見直し | `verification_events` + Aedilis 側 |
| なりすまし報告 (写真提示等) | 当該 attestation を Aedilis で無効化 | チャレンジ必須化 (`OSTIARIUS_FACE_CHALLENGE=required`)、物理監督 | 監査ログ + Cernere audit |
| 端末紛失 (パスキー) | 生徒/職員が Cernere で失効 → 即時 sync | 新端末で device-link 再登録 | Cernere audit |
| カメラ/sidecar 故障 | kiosk は自動で `fallback` (パスキー QR) | 職員 override (`camera_down`) | health + override 理由 |
| Cernere 不通 | 直近 sync キャッシュで顔/パスキー継続 (オフライン設計) | enroll / device-link は不可 (要 Cernere) | sync 失敗 warn |
| Aedilis 不通 | outbox に積んで再送 | 7 日超で職員に通知 | outbox 件数 |

## 7. 未決事項
- 保護者同意の記録を Cernere に持たせるか (現状: 施設ポリシー ID のみ)。
- テンプレートの施設間共有 (同一組織の別施設): 現状は facility 単位 export、組織単位は P3 で判断。
