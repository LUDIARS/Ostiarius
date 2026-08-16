import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { countStaffOverridesSince, listFaceUserIds, recordFaceEvent } from '../db.ts';
import { signAttestation } from '../attestation.ts';
import { deliverAttestation } from '../face/aedilis-outbox.ts';
import { StaffSessionStore } from '../face/staff-session.ts';
import { PasskeyCheckinService, type PasskeyCheckinDeps } from '../passkey-checkin.ts';

const OVERRIDE_REASONS = new Set(['camera_down', 'face_reject', 'no_device', 'other']);

export function makeIdentityStaffRouter(deps: PasskeyCheckinDeps & { staffRoles: readonly string[]; sessions: StaffSessionStore; aedilisBaseUrl: string; aedilisGatewayToken: string; dailyOverrideLimit: number }): Hono {
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
  router.post('/identity/staff/override', async (c) => {
    const actor = deps.sessions.get(c.req.header('x-ostiarius-staff'));
    const body = await c.req.json().catch(() => null) as { subjectUserId?: unknown; reasonCode?: unknown } | null;
    if (!actor) return c.json({ error: 'staff_unauthorized' }, 401);
    if (typeof body?.subjectUserId !== 'string' || typeof body.reasonCode !== 'string' || !OVERRIDE_REASONS.has(body.reasonCode)) return c.json({ error: 'bad_request' }, 400);
    const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0);
    if (countStaffOverridesSince(deps.db, startOfDay.getTime()) >= deps.dailyOverrideLimit) return c.json({ error: 'daily_override_limit' }, 429);
    const attestation = signAttestation({ sub: body.subjectUserId, placeId: deps.facilityId, lanId: deps.lanId, nonce: randomUUID(), issuedAt: Date.now(), method: 'staff_override', assurance: 'manual' }, deps.privateKey);
    await deliverAttestation(deps.db, deps.aedilisBaseUrl, deps.aedilisGatewayToken, attestation);
    recordFaceEvent(deps.db, { kind: 'staff_override', outcome: 'issued', method: 'staff_override', subjectUser: body.subjectUserId, actorUser: actor, reason: body.reasonCode });
    return c.json({ ok: true, method: 'staff_override' });
  });
  return router;
}

function getCredentialFromAttestation(db: Database.Database, userId: string) { return db.prepare<[string], { roles: string }>('SELECT roles FROM credentials WHERE user_id=? LIMIT 1').get(userId) ?? null; }
function parseRoles(value: string): string[] { try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []; } catch { return []; } }
