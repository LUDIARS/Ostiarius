export type AttendanceDelivery =
  | { status: 'recorded'; attendanceId: string; matchedReservation: string | null }
  | { status: 'failed'; code: string };
export type AttendanceSender = (attestation: string) => Promise<AttendanceDelivery>;

/** Credentials stay on Os; browsers receive only the remote recording result. */
export function attendanceSender(baseUrl: string, token: string, send: typeof fetch = fetch): AttendanceSender {
  return async attestation => {
    if (!baseUrl || !token) return { status: 'failed', code: 'AEDILIS_NOT_CONFIGURED' };
    try {
      const url = new URL('/api/checkin/gateway-verify', baseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return { status: 'failed', code: 'AEDILIS_URL_INVALID' };
      const response = await send(url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ attestation }),
      });
      if (!response.ok) { await response.body?.cancel(); return { status: 'failed', code: `AEDILIS_HTTP_${response.status}` }; }
      const body = await response.json() as { ok?: unknown; attendanceId?: unknown; matchedReservation?: unknown };
      if (body.ok !== true || typeof body.attendanceId !== 'string' || !body.attendanceId || !(body.matchedReservation === null || typeof body.matchedReservation === 'string')) {
        return { status: 'failed', code: 'AEDILIS_RESPONSE_INVALID' };
      }
      return { status: 'recorded', attendanceId: body.attendanceId, matchedReservation: body.matchedReservation };
    } catch { return { status: 'failed', code: 'AEDILIS_UNREACHABLE' }; }
  };
}
