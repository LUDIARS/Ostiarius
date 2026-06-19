# data: `credentials` テーブル (passkey 公開鍵キャッシュ)

Ostiarius が持つ唯一の永続テーブル。Cernere から同期した passkey 公開鍵の
**スナップショット (キャッシュ)** であり、これによりオフラインで assertion を
検証できる。個人データは Cernere 単一情報源であり、ここは「公開鍵 + userId
アンカー」のキャッシュに徹する ([[project_personal_data_rule]])。

- 実装: `server/db.ts`
- 物理: better-sqlite3、`journal_mode = WAL`
- DB ファイル: `{OSTIARIUS_DATA}/ostiarius.db` (既定 `./data/ostiarius.db`、`config.ts` の `dbPath`)

## テーブル定義

```sql
CREATE TABLE IF NOT EXISTS credentials (
  user_id       TEXT NOT NULL,
  credential_id TEXT PRIMARY KEY,
  public_key    TEXT NOT NULL,
  counter       INTEGER NOT NULL DEFAULT 0,
  transports    TEXT NOT NULL DEFAULT '[]',
  synced_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS credentials_user ON credentials(user_id);
```

| カラム | 型 | 制約 / 既定 | 意味 |
|---|---|---|---|
| `user_id` | TEXT | NOT NULL | Cernere の user id (assertion 成功時に attestation の `sub` に入るアンカー) |
| `credential_id` | TEXT | PRIMARY KEY | WebAuthn credential.id (base64url)。assertion から credential を引くキー |
| `public_key` | TEXT | NOT NULL | COSE 公開鍵 (base64)。検証時 `Buffer.from(public_key, 'base64')` → `Uint8Array` |
| `counter` | INTEGER | NOT NULL DEFAULT 0 | signature counter。後退は upsert で `MAX()` 保持、検証では best-effort |
| `transports` | TEXT | NOT NULL DEFAULT `'[]'` | `AuthenticatorTransportFuture[]` を JSON 文字列化したもの |
| `synced_at` | INTEGER | NOT NULL | 最終 upsert の epoch ms (`listCredentials` の降順キー) |

`CredentialRow` 型 (`server/db.ts`) がこの行に 1:1 対応する。

## インデックス

- `credentials_user` — `user_id` の二次索引 (PRIMARY KEY は `credential_id`)。

## リレーション / 外部キー

- 外部キー制約は持たない (単一テーブル)。
- `user_id` / `credential_id` / `public_key` の実体は **Cernere 側が正本**。
  ここはその export のキャッシュ。

## マイグレーション方針

- `openDb()` は `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` のみ
  (冪等)。
- カラム追加時は `ALTER TABLE ... ADD COLUMN` を後付けし、**新カラム用 INDEX は
  ALTER の直後**に冪等発行する (既存 DB の boot 失敗を避ける、
  [[feedback_sqlite_create_index_after_alter]])。現状は追加 ALTER なし。
- 稼働中 DB をファイルコピーで差し替えない (WAL 破損、
  [[feedback_sqlite_cp_while_open]])。反映は SQLite 書込経由 (Cernere sync の upsert)。

## 書込 / 読出 経路 (`server/db.ts`)

| 関数 | 用途 | 呼び出し元 |
|---|---|---|
| `upsertCredential` | export 1 件を upsert。`counter` は `MAX(既存, 新)` で後退させない | `cernere-sync.ts` |
| `getCredential(credentialId)` | assertion の credential を引く | `routes/checkin.ts` finish |
| `listCredentials()` | 同期済み全件 (`synced_at` 降順) を `allowCredentials` に詰める | `routes/checkin.ts` begin |
| `countCredentials()` | キャッシュ件数 (health / 起動ログ) | `index.ts` |
| `updateCredentialCounter` | assertion 成功で counter 前進 (前進時のみ) | `routes/checkin.ts` finish |

## 関連

- 同期元: [interface/cernere-passkey-export.md](../interface/cernere-passkey-export.md)
- 検証で消費: [feature/checkin-verification.md](../feature/checkin-verification.md)
- challenge は DB ではなく in-memory: [feature/checkin-verification.md](../feature/checkin-verification.md) の challenge-store を参照
