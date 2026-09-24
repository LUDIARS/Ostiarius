import { expect, it, vi } from 'vitest';
import { attendanceSender } from '../server/attendance-delivery.ts';

it('sends the signed attendance and gateway token to a remote Ae host', async () => {
  const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true, attendanceId: 'record-1', matchedReservation: null }));
  expect(await attendanceSender('https://remote-ae.example', 'server-only-token', send)('signed-attestation')).toEqual({ status: 'recorded', attendanceId: 'record-1', matchedReservation: null });
  const call = send.mock.calls[0];
  expect(String(call?.[0])).toBe('https://remote-ae.example/api/checkin/gateway-verify');
  expect(call?.[1]).toMatchObject({ method: 'POST', redirect: 'error', headers: { authorization: 'Bearer server-only-token' }, body: JSON.stringify({ attestation: 'signed-attestation' }) });
  expect(call?.[1]?.signal).toBeInstanceOf(AbortSignal);
});

it('does not report recorded for missing configuration, rejection, timeout or invalid success body', async () => {
  const send = vi.fn<typeof fetch>();
  expect(await attendanceSender('', '', send)('a')).toMatchObject({ status: 'failed', code: 'AEDILIS_NOT_CONFIGURED' });
  expect(send).not.toHaveBeenCalled();
  send.mockResolvedValueOnce(new Response('', { status: 401 }));
  expect(await attendanceSender('https://remote-ae.example', 'token', send)('a')).toMatchObject({ status: 'failed', code: 'AEDILIS_HTTP_401' });
  send.mockRejectedValueOnce(new Error('timeout'));
  expect(await attendanceSender('https://remote-ae.example', 'token', send)('a')).toMatchObject({ status: 'failed', code: 'AEDILIS_UNREACHABLE' });
  send.mockResolvedValueOnce(Response.json({ ok: true }));
  expect(await attendanceSender('https://remote-ae.example', 'token', send)('a')).toMatchObject({ status: 'failed', code: 'AEDILIS_RESPONSE_INVALID' });
});
