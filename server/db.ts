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
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface CredentialRow {
  user_id: string;
  credential_id: string; // base64url。 WebAuthn の credential.id
  public_key: string; // base64 (COSE)
  counter: number;
  transports: string; // JSON 配列 (AuthenticatorTransportFuture[])
  synced_at: number;
  roles: string;
}

export interface FaceTemplateRow { user_id: string; template_enc: Buffer; model_id: string; quality: number; enrolled_at: number; version: number; synced_at: number; }
export interface OutboxRow { id: number; target: string; payload: string; attempts: number; next_at: number; }

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
    CREATE TABLE IF NOT EXISTS verification_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      at           INTEGER NOT NULL,
      kind         TEXT NOT NULL,
      method       TEXT,
      outcome      TEXT NOT NULL,
      subject_user TEXT,
      actor_user   TEXT,
      session_id   TEXT,
      top1_score   REAL,
      liveness     REAL,
      reason       TEXT,
      sent_at      INTEGER
    );
    CREATE INDEX IF NOT EXISTS verification_events_at ON verification_events(at);
    CREATE INDEX IF NOT EXISTS verification_events_staff_override_daily
      ON verification_events(kind, actor_user, at);
    CREATE TABLE IF NOT EXISTS face_templates (
      user_id TEXT PRIMARY KEY, template_enc BLOB NOT NULL, model_id TEXT NOT NULL,
      quality REAL NOT NULL DEFAULT 0, enrolled_at INTEGER NOT NULL, version INTEGER NOT NULL, synced_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL, payload TEXT NOT NULL,
      created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS outbox_next_at ON outbox(next_at);
  `);
  const columns = db.prepare<[], { name: string }>('PRAGMA table_info(credentials)').all();
  if (!columns.some((column) => column.name === 'roles')) db.exec("ALTER TABLE credentials ADD COLUMN roles TEXT NOT NULL DEFAULT '[]'");
  return db;
}

export function encryptFaceTemplate(template: Float32Array, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error('OSTIARIUS_TEMPLATE_KEY must decode to 32 bytes');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const plain = Buffer.from(template.buffer, template.byteOffset, template.byteLength);
  return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

export function decryptFaceTemplate(value: Buffer, key: Buffer): Float32Array {
  if (key.length !== 32 || value.length < 29) throw new Error('invalid encrypted face template');
  const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
  decipher.setAuthTag(value.subarray(value.length - 16));
  const plain = Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]);
  if (plain.length !== 512 * 4) throw new Error('face template dimension mismatch');
  return new Float32Array(plain.buffer, plain.byteOffset, 512).slice();
}

export function upsertFaceTemplate(db: Database.Database, row: { userId: string; template: Float32Array; modelId: string; quality: number; enrolledAt: number; version: number; key: Buffer }): void {
  db.prepare(`INSERT INTO face_templates (user_id,template_enc,model_id,quality,enrolled_at,version,synced_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET template_enc=excluded.template_enc,model_id=excluded.model_id,quality=excluded.quality,enrolled_at=excluded.enrolled_at,version=excluded.version,synced_at=excluded.synced_at`)
    .run(row.userId, encryptFaceTemplate(row.template, row.key), row.modelId, row.quality, row.enrolledAt, row.version, Date.now());
}
export function listFaceTemplates(db: Database.Database): FaceTemplateRow[] { return db.prepare<[], FaceTemplateRow>('SELECT * FROM face_templates ORDER BY user_id').all(); }
export function deleteFaceTemplate(db: Database.Database, userId: string): void { db.prepare('DELETE FROM face_templates WHERE user_id=?').run(userId); }
export function countFaceTemplates(db: Database.Database): number { return (db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM face_templates').get()?.n ?? 0); }
export function recordFaceEvent(db: Database.Database, event: { outcome: string; method?: string; subjectUser?: string; actorUser?: string; sessionId?: string; score?: number; liveness?: number; reason?: string; kind?: string }): void {
  db.prepare('INSERT INTO verification_events (at,kind,method,outcome,subject_user,actor_user,session_id,top1_score,liveness,reason) VALUES (?,?,?,?,?,?,?,?,?,?)').run(Date.now(), event.kind ?? 'verify', event.method ?? null, event.outcome, event.outcome === 'issued' ? event.subjectUser ?? null : null, event.actorUser ?? null, event.sessionId ?? null, event.score ?? null, event.liveness ?? null, event.reason ?? null);
}

export function countStaffOverridesSince(db: Database.Database, actorUser: string, since: number): number {
  return db.prepare<[string, string, number], { n: number }>(
    'SELECT COUNT(*) AS n FROM verification_events WHERE kind = ? AND actor_user = ? AND at >= ?',
  ).get('staff_override', actorUser, since)?.n ?? 0;
}
export function rotateFaceEvents(db: Database.Database, retentionDays: number): void {
  db.prepare('DELETE FROM verification_events WHERE at < ?').run(Date.now() - retentionDays * 86_400_000);
}
export function listFaceUserIds(db: Database.Database): string[] {
  return db.prepare<[], { user_id: string }>('SELECT user_id FROM face_templates ORDER BY user_id').all().map((row) => row.user_id);
}
export function enqueueOutbox(db: Database.Database, target: string, payload: string): void { const now = Date.now(); db.prepare('INSERT INTO outbox (target,payload,created_at,next_at) VALUES (?,?,?,?)').run(target, payload, now, now); }
export function listDueOutbox(db: Database.Database, now = Date.now()): OutboxRow[] { return db.prepare<[number], OutboxRow>('SELECT id,target,payload,attempts,next_at FROM outbox WHERE next_at<=? ORDER BY id').all(now); }
export function acknowledgeOutbox(db: Database.Database, id: number): void { db.prepare('DELETE FROM outbox WHERE id=?').run(id); }
export function deferOutbox(db: Database.Database, row: OutboxRow): void { const attempts = row.attempts + 1; const delay = Math.min(30_000 * 2 ** attempts, 900_000); db.prepare('UPDATE outbox SET attempts=?,next_at=? WHERE id=?').run(attempts, Date.now() + delay, row.id); }
export function countOutbox(db: Database.Database): number { return db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM outbox').get()?.n ?? 0; }

/** 発行済み本人確認の画像を含まない監査イベントを残す。 */
export function recordVerificationIssued(
  db: Database.Database,
  args: { method: 'passkey' | 'session' | 'password'; subjectUser: string; sessionId?: string },
): void {
  db.prepare(
    `INSERT INTO verification_events (at, kind, method, outcome, subject_user, session_id)
     VALUES (?, 'verify', ?, 'issued', ?, ?)`,
  ).run(Date.now(), args.method, args.subjectUser, args.sessionId ?? null);
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
    roles?: string[];
  },
): void {
  db.prepare(
    `INSERT INTO credentials
       (user_id, credential_id, public_key, counter, transports, synced_at, roles)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(credential_id) DO UPDATE SET
       user_id    = excluded.user_id,
       public_key = excluded.public_key,
       counter    = MAX(credentials.counter, excluded.counter),
       transports = excluded.transports,
       roles      = excluded.roles,
       synced_at  = excluded.synced_at`,
  ).run(
    args.userId,
    args.credentialId,
    args.publicKey,
    args.counter,
    JSON.stringify(args.transports),
    Date.now(),
    JSON.stringify(args.roles ?? []),
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
