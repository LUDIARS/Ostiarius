// Ostiarius 永続層 — better-sqlite3。
//
// 持つのは Cernere から同期した passkey 公開鍵の **キャッシュ** のみ。
// 個人データは Cernere 単一情報源 ([[project_personal_data_rule]])。 ここは
// オフライン検証のための「公開鍵 + userId アンカー」のスナップショットに徹する。
//
// migration は CREATE IF NOT EXISTS のみ。 カラム追加時は ALTER ADD COLUMN を
// 後付けし、 新カラム用 INDEX は ALTER の直後に冪等発行する (既存 DB の boot 失敗防止)。

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface CredentialRow {
  user_id: string;
  credential_id: string; // base64url。 WebAuthn の credential.id
  public_key: string; // base64 (COSE)
  counter: number;
  transports: string; // JSON 配列 (AuthenticatorTransportFuture[])
  synced_at: number;
}

export function openDb(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS credentials (
      user_id       TEXT NOT NULL,
      credential_id TEXT PRIMARY KEY,
      public_key    TEXT NOT NULL,
      counter       INTEGER NOT NULL DEFAULT 0,
      transports    TEXT NOT NULL DEFAULT '[]',
      synced_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS credentials_user ON credentials(user_id);
  `);
  return db;
}

/** Cernere export 1 件を upsert。 counter は後退させない (best-effort、 clone 警戒)。 */
export function upsertCredential(
  db: Database.Database,
  args: {
    userId: string;
    credentialId: string;
    publicKey: string;
    counter: number;
    transports: string[];
  },
): void {
  db.prepare(
    `INSERT INTO credentials
       (user_id, credential_id, public_key, counter, transports, synced_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(credential_id) DO UPDATE SET
       user_id    = excluded.user_id,
       public_key = excluded.public_key,
       counter    = MAX(credentials.counter, excluded.counter),
       transports = excluded.transports,
       synced_at  = excluded.synced_at`,
  ).run(
    args.userId,
    args.credentialId,
    args.publicKey,
    args.counter,
    JSON.stringify(args.transports),
    Date.now(),
  );
}

export function getCredential(
  db: Database.Database,
  credentialId: string,
): CredentialRow | null {
  return (
    db
      .prepare<[string], CredentialRow>(
        `SELECT * FROM credentials WHERE credential_id = ?`,
      )
      .get(credentialId) ?? null
  );
}

export function listCredentials(db: Database.Database): CredentialRow[] {
  return db
    .prepare<[], CredentialRow>(`SELECT * FROM credentials ORDER BY synced_at DESC`)
    .all();
}

export function countCredentials(db: Database.Database): number {
  const row = db
    .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM credentials`)
    .get();
  return row?.n ?? 0;
}

/** assertion 成功後に counter を進める。 後退 (clone 徴候) は呼び出し側で warn。 */
export function updateCredentialCounter(
  db: Database.Database,
  credentialId: string,
  newCounter: number,
): void {
  db.prepare(`UPDATE credentials SET counter = ? WHERE credential_id = ?`).run(
    newCounter,
    credentialId,
  );
}
