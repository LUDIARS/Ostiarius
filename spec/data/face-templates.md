# data: `face_templates` / `verification_events` / `outbox` (本人確認ゲート用テーブル)

[credentials.md](credentials.md) と同じ方針: **個人データの正本は Cernere**、Ostiarius は
施設単位のキャッシュ + 画像を含まない監査ログ。実装: `server/db.ts` (`CREATE ... IF NOT EXISTS` 冪等)。

## `face_templates` — 顔テンプレートキャッシュ (Cernere export のスナップショット)

```sql
CREATE TABLE IF NOT EXISTS face_templates (
  user_id       TEXT PRIMARY KEY,
  template_enc  BLOB NOT NULL,          -- AES-256-GCM(nonce||ct||tag) で暗号化した float32[512] (little-endian)
  model_id      TEXT NOT NULL,          -- 例 'insightface/glintr100@1'
  quality       REAL NOT NULL DEFAULT 0,
  enrolled_at   INTEGER NOT NULL,
  version       INTEGER NOT NULL,       -- Cernere 側の版 (再登録で増える)
  synced_at     INTEGER NOT NULL
);
```

- 暗号鍵は `OSTIARIUS_TEMPLATE_KEY` (Infisical、32 byte base64)。DB ファイル単体が漏れても
  テンプレートは読めない。復号は roster ロード時にメモリ上のみ。
- roster (メモリ) は起動時 + sync 後に再構築: `Float32Array[N*512]` + `user_id[]`。
  `model_id` が sidecar の `modelId` と異なる行は roster に載せない (警告)。
- 削除: export の tombstone (`revoked: true`) で行削除。sync 応答に無い user も削除 (完全同期、
  passkey の credentials と同じ全量スナップショット方式)。
- **画像・サムネイルは持たない。**

## `verification_events` — 監査ログ (画像なし)

```sql
CREATE TABLE IF NOT EXISTS verification_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            INTEGER NOT NULL,
  kind          TEXT NOT NULL,          -- 'verify' | 'enroll' | 'staff_override' | 'sync' | 'revoke'
  method        TEXT,                   -- attestation.method (verify 時)
  outcome       TEXT NOT NULL,          -- 'issued' | 'no_match' | 'ambiguous' | 'spoof_suspected' | 'challenge_failed' | 'timeout' | 'error'
  subject_user  TEXT,                   -- 生徒 userId (確定時のみ)
  actor_user    TEXT,                   -- 職員 userId (enroll / override)
  session_id    TEXT,
  top1_score    REAL,                   -- verify 時 (匿名統計用、user と結びつくのは issued のみ)
  liveness      REAL,
  reason        TEXT,                   -- override 理由 / エラー概要
  sent_at       INTEGER                 -- Aedilis へ要約送信済み時刻
);
CREATE INDEX IF NOT EXISTS verification_events_at ON verification_events(at);
```

- 保持 90 日、日次でローテート削除 (`OSTIARIUS_EVENT_RETENTION_DAYS`)。
- `no_match` 等の失敗行には `subject_user` を入れない (誰と誤認したかは残さない)。

## `outbox` — Aedilis への attestation / 要約の再送キュー

```sql
CREATE TABLE IF NOT EXISTS outbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target      TEXT NOT NULL,            -- 'aedilis:attest' | 'aedilis:events'
  payload     TEXT NOT NULL,            -- JSON
  created_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_at     INTEGER NOT NULL
);
```

指数バックオフ (30s → 最大 15min)、成功で削除。attestation 自体は署名済みなので遅延送信でも
Aedilis 側で `issuedAt` を見て受理判断できる。

## `credentials` への追加列

```sql
ALTER TABLE credentials ADD COLUMN roles TEXT NOT NULL DEFAULT '[]';   -- Cernere export の roles (P3 以降)
```

`openDb()` で `PRAGMA table_info` を見て無ければ追加 (冪等)。
