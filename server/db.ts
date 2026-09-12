// Ostiarius 永続層 — better-sqlite3。
//
// 2 種類のデータを持つ:
//   - Cernere から同期した passkey 公開鍵の **キャッシュ** (正本は Cernere)
//   - 顔テンプレート・顔写真・同意の写しという **施設の正本**
//     (spec/plan/face-data-local-only.md — 2026-09-12 に Cernere から移管)。
//     テンプレートと写真は封緘済み blob と `key_id` としてのみここへ入る。
//     平文を列に入れない (封緘は face/local-key.ts、鍵はホスト外へ出さない)。
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
  roles: string;
}

/** 出席照合に載る状態。`pending` は職員が昇格するまで照合に使わない。 */
export type FaceTemplateState = 'pending' | 'active' | 'revoked';

export interface FaceTemplateRow {
  user_id: string;
  facility_id: string;
  template_enc: Buffer;
  key_id: string;
  model_id: string;
  quality: number;
  version: number;
  state: FaceTemplateState;
  consent_id: string | null;
  enrolled_by: string | null;
  enrolled_at: number;
  revoked_at: number | null;
  revoke_reason: string | null;
}

export interface FacePhotoRow {
  user_id: string;
  facility_id: string;
  photo_enc: Buffer;
  key_id: string;
  content_type: string;
  consent_id: string | null;
  created_at: number;
}

/** Cernere 正本の同意記録の写し (照合可否を Cernere 不通時にも自前判定するため)。 */
export interface FaceConsentCopyRow {
  user_id: string;
  consent_id: string;
  policy_version: string;
  at: number;
  revoked_at: number | null;
}

export interface OutboxRow { id: number; target: string; payload: string; attempts: number; next_at: number; }

/** 1 人分の顔データの残り行数 (削除が同時に効いたかの検査に使う)。 */
export interface FaceSubjectRowCounts { templates: number; photos: number; consents: number; }

const FACE_SCHEMA = `
    CREATE TABLE IF NOT EXISTS face_templates (
      user_id       TEXT PRIMARY KEY,
      facility_id   TEXT NOT NULL DEFAULT '',
      template_enc  BLOB NOT NULL,
      key_id        TEXT NOT NULL DEFAULT '',
      model_id      TEXT NOT NULL,
      quality       REAL NOT NULL DEFAULT 0,
      version       INTEGER NOT NULL,
      state         TEXT NOT NULL DEFAULT 'pending',
      consent_id    TEXT,
      enrolled_by   TEXT,
      enrolled_at   INTEGER NOT NULL,
      revoked_at    INTEGER,
      revoke_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS face_templates_state ON face_templates(state);
    CREATE TABLE IF NOT EXISTS face_photos (
      user_id      TEXT PRIMARY KEY,
      facility_id  TEXT NOT NULL DEFAULT '',
      photo_enc    BLOB NOT NULL,
      key_id       TEXT NOT NULL,
      content_type TEXT NOT NULL DEFAULT 'image/jpeg',
      consent_id   TEXT,
      created_at   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS face_consents_copy (
      user_id        TEXT PRIMARY KEY,
      consent_id     TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      at             INTEGER NOT NULL,
      revoked_at     INTEGER
    );
    CREATE TABLE IF NOT EXISTS sync_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
`;

/**
 * 同期キャッシュ時代の `face_templates` を正本スキーマへ差し替える。
 *
 * 旧行は Cernere の施設配布鍵 (`OSTIARIUS_TEMPLATE_KEY`) で封緘されている。その鍵の
 * 配布は廃止したので、残しても二度と開けない (spec/plan/face-data-local-only.md §6-2:
 * 既登録者は kiosk で再 enroll)。開けない行を roster に載せ続けないよう、旧表は捨てる。
 */
function migrateLegacyFaceTemplates(db: Database.Database): void {
  const tables = db.prepare<[], { name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='face_templates'",
  ).all();
  if (!tables.length) return;
  const columns = db.prepare<[], { name: string }>('PRAGMA table_info(face_templates)').all();
  if (columns.some((column) => column.name === 'state')) return;
  const stale = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM face_templates').get()?.n ?? 0;
  db.exec('DROP TABLE face_templates');
  if (stale > 0) {
    console.warn(
      `[ostiarius] 旧 Cernere 同期キャッシュの顔テンプレート ${stale} 件を破棄しました `
      + '(封緘鍵がホスト内生成へ移行したため復号できません — kiosk で再登録してください)',
    );
  }
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
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL, payload TEXT NOT NULL,
      created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS outbox_next_at ON outbox(next_at);
  `);
  migrateLegacyFaceTemplates(db);
  db.exec(FACE_SCHEMA);
  const columns = db.prepare<[], { name: string }>('PRAGMA table_info(credentials)').all();
  if (!columns.some((column) => column.name === 'roles')) db.exec("ALTER TABLE credentials ADD COLUMN roles TEXT NOT NULL DEFAULT '[]'");
  return db;
}

/** 封緘済みテンプレート 1 件。平文の埋め込みはここへ来ない (face/local-store.ts が封緘する)。 */
export interface FaceTemplateRecord {
  userId: string;
  facilityId: string;
  templateEnc: Buffer;
  keyId: string;
  modelId: string;
  quality: number;
  version: number;
  state: FaceTemplateState;
  consentId: string | null;
  enrolledBy: string | null;
  enrolledAt: number;
}

export function upsertFaceTemplate(db: Database.Database, row: FaceTemplateRecord): void {
  db.prepare(
    `INSERT INTO face_templates
       (user_id, facility_id, template_enc, key_id, model_id, quality, version, state, consent_id, enrolled_by, enrolled_at, revoked_at, revoke_reason)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)
     ON CONFLICT(user_id) DO UPDATE SET
       facility_id=excluded.facility_id, template_enc=excluded.template_enc, key_id=excluded.key_id,
       model_id=excluded.model_id, quality=excluded.quality, version=excluded.version, state=excluded.state,
       consent_id=excluded.consent_id, enrolled_by=excluded.enrolled_by, enrolled_at=excluded.enrolled_at,
       revoked_at=NULL, revoke_reason=NULL`,
  ).run(
    row.userId, row.facilityId, row.templateEnc, row.keyId, row.modelId, row.quality,
    row.version, row.state, row.consentId, row.enrolledBy, row.enrolledAt,
  );
}

export function getFaceTemplate(db: Database.Database, userId: string): FaceTemplateRow | null {
  return db.prepare<[string], FaceTemplateRow>('SELECT * FROM face_templates WHERE user_id=?').get(userId) ?? null;
}

export function listFaceTemplates(db: Database.Database, state?: FaceTemplateState): FaceTemplateRow[] {
  return state
    ? db.prepare<[string], FaceTemplateRow>('SELECT * FROM face_templates WHERE state=? ORDER BY user_id').all(state)
    : db.prepare<[], FaceTemplateRow>('SELECT * FROM face_templates ORDER BY user_id').all();
}

/** 状態遷移 (pending → active、職員無効化 → revoked)。 */
export function setFaceTemplateState(
  db: Database.Database,
  userId: string,
  state: FaceTemplateState,
  options: { at?: number; reason?: string } = {},
): boolean {
  const revoked = state === 'revoked';
  const result = db.prepare('UPDATE face_templates SET state=?, revoked_at=?, revoke_reason=? WHERE user_id=?').run(
    state,
    revoked ? options.at ?? Date.now() : null,
    revoked ? options.reason ?? null : null,
    userId,
  );
  return result.changes > 0;
}

export function deleteFaceTemplate(db: Database.Database, userId: string): void {
  db.prepare('DELETE FROM face_templates WHERE user_id=?').run(userId);
}

export function countFaceTemplates(db: Database.Database, state?: FaceTemplateState): number {
  return state
    ? db.prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM face_templates WHERE state=?').get(state)?.n ?? 0
    : db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM face_templates').get()?.n ?? 0;
}

/** 封緘済みプロフィール顔写真 1 枚。 */
export interface FacePhotoRecord {
  userId: string;
  facilityId: string;
  photoEnc: Buffer;
  keyId: string;
  contentType: string;
  consentId: string | null;
  createdAt: number;
}

export function upsertFacePhoto(db: Database.Database, row: FacePhotoRecord): void {
  db.prepare(
    `INSERT INTO face_photos (user_id, facility_id, photo_enc, key_id, content_type, consent_id, created_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       facility_id=excluded.facility_id, photo_enc=excluded.photo_enc, key_id=excluded.key_id,
       content_type=excluded.content_type, consent_id=excluded.consent_id, created_at=excluded.created_at`,
  ).run(row.userId, row.facilityId, row.photoEnc, row.keyId, row.contentType, row.consentId, row.createdAt);
}

export function getFacePhoto(db: Database.Database, userId: string): FacePhotoRow | null {
  return db.prepare<[string], FacePhotoRow>('SELECT * FROM face_photos WHERE user_id=?').get(userId) ?? null;
}

export function deleteFacePhoto(db: Database.Database, userId: string): void {
  db.prepare('DELETE FROM face_photos WHERE user_id=?').run(userId);
}

/** 写真を持つ userId 一覧 (審査候補の表示に使う。バイト列は返さない)。 */
export function listFacePhotoUserIds(db: Database.Database): string[] {
  return db.prepare<[], { user_id: string }>('SELECT user_id FROM face_photos ORDER BY user_id').all()
    .map((row) => row.user_id);
}

export interface FaceConsentCopyRecord {
  userId: string;
  consentId: string;
  policyVersion: string;
  at: number;
  revokedAt: number | null;
}

export function upsertFaceConsentCopy(db: Database.Database, row: FaceConsentCopyRecord): void {
  db.prepare(
    `INSERT INTO face_consents_copy (user_id, consent_id, policy_version, at, revoked_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       consent_id=excluded.consent_id, policy_version=excluded.policy_version,
       at=excluded.at, revoked_at=excluded.revoked_at`,
  ).run(row.userId, row.consentId, row.policyVersion, row.at, row.revokedAt);
}

export function getFaceConsentCopy(db: Database.Database, userId: string): FaceConsentCopyRow | null {
  return db.prepare<[string], FaceConsentCopyRow>('SELECT * FROM face_consents_copy WHERE user_id=?').get(userId) ?? null;
}

export function listFaceConsentCopies(db: Database.Database): FaceConsentCopyRow[] {
  return db.prepare<[], FaceConsentCopyRow>('SELECT * FROM face_consents_copy ORDER BY user_id').all();
}

/**
 * 1 人分の顔データを **まとめて物理削除** する。
 *
 * spec/plan/biometric-data-policy.md §3: 写真だけ残る / テンプレートだけ残る状態を
 * 作らない。削除経路 (失効指示、kiosk 上の本人削除、却下) はすべてここを通す。
 */
export function purgeFaceSubject(db: Database.Database, userId: string): FaceSubjectRowCounts {
  const before = countFaceSubjectRows(db, userId);
  db.transaction(() => {
    deleteFaceTemplate(db, userId);
    deleteFacePhoto(db, userId);
    db.prepare('DELETE FROM face_consents_copy WHERE user_id=?').run(userId);
  })();
  return before;
}

export function countFaceSubjectRows(db: Database.Database, userId: string): FaceSubjectRowCounts {
  const count = (table: 'face_templates' | 'face_photos' | 'face_consents_copy'): number =>
    db.prepare<[string], { n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?`).get(userId)?.n ?? 0;
  return { templates: count('face_templates'), photos: count('face_photos'), consents: count('face_consents_copy') };
}

/** 同期の再開位置など、小さな運用状態の置き場。 */
export function getSyncState(db: Database.Database, key: string): string | null {
  return db.prepare<[string], { value: string }>('SELECT value FROM sync_state WHERE key=?').get(key)?.value ?? null;
}

export function setSyncState(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO sync_state (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  ).run(key, value, Date.now());
}

/**
 * 画像・テンプレートを含まない監査イベントを残す。
 *
 * 1:N 照合の失敗行だけは subject を残さない (誰が弾かれたかの推測材料を作らない)。
 * enroll / 審査 / 写真閲覧 / 削除は「誰の何を誰が操作したか」が監査の目的なので残す。
 */
export function recordFaceEvent(db: Database.Database, event: { outcome: string; method?: string; subjectUser?: string; actorUser?: string; sessionId?: string; score?: number; liveness?: number; reason?: string; kind?: string }): void {
  const kind = event.kind ?? 'verify';
  const anonymousFailure = kind === 'verify' && event.outcome !== 'issued';
  db.prepare('INSERT INTO verification_events (at,kind,method,outcome,subject_user,actor_user,session_id,top1_score,liveness,reason) VALUES (?,?,?,?,?,?,?,?,?,?)').run(Date.now(), kind, event.method ?? null, event.outcome, anonymousFailure ? null : event.subjectUser ?? null, event.actorUser ?? null, event.sessionId ?? null, event.score ?? null, event.liveness ?? null, event.reason ?? null);
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
