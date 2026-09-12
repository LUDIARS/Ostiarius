// 職員向け API — passkey 認証、名簿、override、顔写真の閲覧、即時 sync。
//
// 顔写真の閲覧 (spec/plan/biometric-data-policy.md §5):
//   - **LAN 内 + 職員セッション必須**。施設外 (Cloudflare Tunnel 等) へは公開しない。
//   - 取得は 1 件ずつ。一覧一括ダウンロードの口を作らない。
//   - 誰がどの生徒の写真を見たかを監査ログに残す。
//   - 応答は `Cache-Control: private, no-store` (端末・中継に残さない)。
//   - kiosk の待機画面には出さない (表示先は職員画面と本人確認時のみ)。

import { Hono } from 'hono';
import type { Context } from 'hono';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { countStaffOverridesSince, listFaceUserIds, recordFaceEvent } from '../db.ts';
import { signAttestation } from '../attestation.ts';
import { deliverAttestation } from '../face/aedilis-outbox.ts';
import type { LocalFaceKeys } from '../face/local-key.ts';
import { readFacePhoto } from '../face/local-store.ts';
import { StaffSessionStore } from '../face/staff-session.ts';
import { PasskeyCheckinService, type PasskeyCheckinDeps } from '../passkey-checkin.ts';

const OVERRIDE_REASONS = new Set(['camera_down', 'face_reject', 'no_device', 'other']);

const PHOTO_HEADERS = {
  'cache-control': 'private, no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

export interface IdentityStaffDeps extends PasskeyCheckinDeps {
  staffRoles: readonly string[];
  sessions: StaffSessionStore;
  aedilisBaseUrl: string;
  aedilisGatewayToken: string;
  dailyOverrideLimit: number;
  /** ローカル正本の封緘鍵 (写真を開くのに使う)。 */
  keys: LocalFaceKeys;
  /** 施設 LAN 内からの要求か。 */
  isLan: (c: Context) => boolean;
  /** Cernere からの失効指示・同意の即時 pull。 */
  syncNow: () => Promise<unknown>;
}

export function makeIdentityStaffRouter(deps: IdentityStaffDeps): Hono {
  const router = new Hono();
  let issued: { userId: string; token: string } | null = null;
  const service = new PasskeyCheckinService(deps, undefined, (userId) => {
    issued = { userId, token: deps.sessions.create(userId) };
  });
  router.post('/identity/staff/begin', async (c) => service.begin(c));
  router.post('/identity/staff/finish', async (c) => {
    const response = await service.finish(c);
    if (!response.ok || !issued) return response;
    const row = getCredentialFromAttestation(deps.db, issued.userId);
    const roles = row ? parseRoles(row.roles) : [];
    if (!roles.some((role) => deps.staffRoles.includes(role))) return c.json({ error: 'staff_role_required' }, 403);
    const staffSession = issued.token; issued = null;
    return c.json({ ok: true, staffSession });
  });
  router.get('/identity/staff/roster', (c) => {
    if (!deps.sessions.get(c.req.header('x-ostiarius-staff'))) return c.json({ error: 'staff_unauthorized' }, 401);
    const q = (c.req.query('q') ?? '').trim();
    return c.json({ users: listFaceUserIds(deps.db).filter((userId) => userId.includes(q)).map((userId) => ({ userId, hint: `ID / ${userId.slice(-2)}` })) });
  });

  /** 職員の名簿・出席確認画面と、kiosk 上での本人確認に出す写真 1 枚。 */
  router.get('/identity/face-photo/:userId', (c) => {
    const actor = deps.sessions.get(c.req.header('x-ostiarius-staff'));
    if (!actor) return c.json({ error: 'staff_unauthorized' }, 401, PHOTO_HEADERS);
    if (!deps.isLan(c)) return c.json({ error: 'lan_only' }, 403, PHOTO_HEADERS);
    const userId = c.req.param('userId');
    const photo = readFacePhoto(deps.db, deps.keys, userId);
    if (!photo) return c.json({ error: 'photo_not_found' }, 404, PHOTO_HEADERS);
    // 誰がどの生徒の写真を見たかを残す (写真そのものはログに載せない)。
    recordFaceEvent(deps.db, { kind: 'photo_view', outcome: 'served', subjectUser: userId, actorUser: actor });
    // Buffer をそのまま渡さず、ArrayBuffer 裏付けの Uint8Array へ写して返す。
    return c.body(Uint8Array.from(photo.bytes), 200, { ...PHOTO_HEADERS, 'content-type': photo.contentType });
  });

  /** 失効指示・同意の即時 pull (生徒が Cernere で削除した直後に職員が押す)。 */
  router.post('/identity/admin/sync', async (c) => {
    if (!deps.sessions.get(c.req.header('x-ostiarius-staff'))) return c.json({ error: 'staff_unauthorized' }, 401);
    const result = await deps.syncNow();
    return c.json({ ok: true, result }, 200, { 'cache-control': 'no-store' });
  });

  router.post('/identity/staff/override', async (c) => {
    const actor = deps.sessions.get(c.req.header('x-ostiarius-staff'));
    const body = await c.req.json().catch(() => null) as { subjectUserId?: unknown; reasonCode?: unknown } | null;
    if (!actor) return c.json({ error: 'staff_unauthorized' }, 401);
    if (typeof body?.subjectUserId !== 'string' || typeof body.reasonCode !== 'string' || !OVERRIDE_REASONS.has(body.reasonCode)) return c.json({ error: 'bad_request' }, 400);
    const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0);
    if (countStaffOverridesSince(deps.db, actor, startOfDay.getTime()) >= deps.dailyOverrideLimit) return c.json({ error: 'daily_override_limit' }, 429);
    const attestation = signAttestation({ sub: body.subjectUserId, placeId: deps.facilityId, lanId: deps.lanId, nonce: randomUUID(), issuedAt: Date.now(), method: 'staff_override', assurance: 'manual' }, deps.privateKey);
    await deliverAttestation(deps.db, deps.aedilisBaseUrl, deps.aedilisGatewayToken, attestation);
    recordFaceEvent(deps.db, { kind: 'staff_override', outcome: 'issued', method: 'staff_override', subjectUser: body.subjectUserId, actorUser: actor, reason: body.reasonCode });
    return c.json({ ok: true, method: 'staff_override' });
  });
  return router;
}

function getCredentialFromAttestation(db: Database.Database, userId: string) { return db.prepare<[string], { roles: string }>('SELECT roles FROM credentials WHERE user_id=? LIMIT 1').get(userId) ?? null; }
function parseRoles(value: string): string[] { try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []; } catch { return []; } }
