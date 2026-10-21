import { createHmac, timingSafeEqual } from 'node:crypto';

export interface FacilityChallenge {
  purpose: 'glab-facility-attendance'; sub: string; facilityId: string; lanId: string;
  nonce: string; issuedAt: number; expiresAt: number;
}

/** Validates GLab's short-lived authenticated-user assertion for this gateway only.
 * @implements SPEC-OS-GLAB-AUTO-001
 */
export function verifyFacilityChallenge(raw: string, secret: string, facilityId: string, lanId: string, now: number): FacilityChallenge | null {
  if (raw.length > 8192 || secret.length < 32) return null;
  const parts = raw.split('.');
  const [payload, signature] = parts;
  if (parts.length !== 2 || !payload || !signature || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) return null;
  const expected = createHmac('sha256', secret).update(payload).digest();
  const received = Buffer.from(signature, 'base64url');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as FacilityChallenge;
    if (value.purpose !== 'glab-facility-attendance' || value.facilityId !== facilityId || value.lanId !== lanId
      || typeof value.sub !== 'string' || !value.sub || value.sub.length > 512
      || typeof value.nonce !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(value.nonce)
      || !Number.isFinite(value.issuedAt) || !Number.isFinite(value.expiresAt)
      || value.issuedAt > now || value.expiresAt <= now || value.expiresAt <= value.issuedAt
      || value.expiresAt - value.issuedAt > 60_000) return null;
    return value;
  } catch { return null; }
}

export interface AutomaticAttendanceConfig { secret: string; origin: string; interfaceName: string }

/** @implements SPEC-OS-GLAB-AUTO-001 */
export function automaticAttendanceConfig(env: NodeJS.ProcessEnv, tls: boolean): AutomaticAttendanceConfig | null {
  const secret = env.OSTIARIUS_GLAB_ATTENDANCE_SECRET;
  const origin = env.OSTIARIUS_GLAB_ORIGIN;
  if (!secret && !origin) return null;
  const interfaceName = env.OSTIARIUS_COCOIRU_LAN_INTERFACE?.trim();
  if (!secret || secret.length < 32 || !origin || !interfaceName || !tls) throw new Error('Incomplete GLab facility attendance configuration');
  const parsed = new URL(origin);
  if (parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.username || parsed.password) throw new Error('GLab origin must be an HTTPS origin');
  return { secret, origin, interfaceName };
}
