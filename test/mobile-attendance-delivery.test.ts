import { expect, it, vi } from 'vitest';
import { makeMobileCheckinRouter } from '../server/routes/mobile-checkin.ts';
import type { MobileCheckinDeps } from '../server/mobile-checkin.ts';
import type { AttendanceDelivery } from '../server/attendance-delivery.ts';

vi.mock('../server/mobile-checkin.ts', () => ({
  generateWifiQrPng: vi.fn(),
  loginAndAttest: async () => ({ accessToken: 'private-user-token', attestation: 'signed', profile: null }),
  tokenAndAttest: async () => ({ attestation: 'signed', profile: null }),
}));

for (const route of ['/checkin/mobile-login', '/checkin/session']) {
  for (const recorded of [true, false]) {
    it(`${route} reports ${recorded ? 'recorded' : 'failed'} remote delivery without relaying credentials to the browser`, async () => {
      const attendance: AttendanceDelivery = recorded ? { status: 'recorded', attendanceId: 'id', matchedReservation: null } : { status: 'failed', code: 'AEDILIS_UNREACHABLE' };
      const sendAttendance = vi.fn(async () => attendance);
      const router = makeMobileCheckinRouter({ wifiSsid: '', wifiPassword: '', aedilisBaseUrl: 'https://remote-ae.example', sessionCheckinEnabled: true, passwordCheckinEnabled: true, loginDeps: {} as MobileCheckinDeps, sendAttendance });
      const response = await router.request(route, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer user-token' }, body: JSON.stringify({ email: 'person@example.com', password: 'password' }) });
      expect(response.status).toBe(recorded ? 200 : 502);
      expect(await response.json()).toEqual({ profile: null, attendance });
      expect(sendAttendance).toHaveBeenCalledWith('signed');
      const html = await (await router.request('/mobile-checkin')).text();
      expect(html).not.toContain('/api/checkin/verify');
      expect(html).not.toContain('private-user-token');
    });
  }
}
