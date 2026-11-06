/** @implements SPEC-OS-COCOIRU-SCOPED-NATIVE-001 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CocoiruSessionError } from '../server/cocoiru-session-store.ts';
import { CompositeAuthorityError } from '../server/vendor/cernere-composite/service-session.js';
import { cocoiruNativeConfig } from '../server/cocoiru-native-config.ts';
import { cocoiruAuthority, opaque } from './cocoiru-authority-fixture.ts';
const operation = { action: 'attendance.cocoiru.attest', resource: 'facility:current:lan:current:attendance', body: ' {} ' };
describe('Cocoiru native ownership', () => {
  it('binds only its configured project and returns only a bounded opaque credential', async () => {
    const f = cocoiruAuthority();
    const created = await f.create();
    expect(Object.keys(created).sort()).toEqual(['expiresAt', 'sessionToken']);
    expect(created.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const bind = f.call.mock.calls.find(([action]) => action === 'bind')?.[1] as { sessionBinding: string };
    expect(bind.sessionBinding).toBe(createHash('sha256').update(created.sessionToken).digest('base64url'));
    expect(Date.parse(created.expiresAt)).toBeLessThanOrEqual(Date.now() + 900_000);
    const bad = cocoiruAuthority(); bad.metadata.projectKey = 'another';
    await expect(bad.create()).rejects.toThrow();
    expect(bad.call.mock.calls.filter(([action]) => action === 'revoke')).toHaveLength(1);
  });
  it('runs the current shared check and one permit/consume with exact action/resource/body digest', async () => {
    const f = cocoiruAuthority(), created = await f.create(), execute = vi.fn(() => 'issued');
    await expect(f.store.run(created.sessionToken, operation, new AbortController().signal, () => true, execute)).resolves.toBe('issued');
    expect(f.call.mock.calls.map(([action]) => action)).toEqual(['bind', 'check', 'authorize', 'consume']);
    const permit = f.call.mock.calls.find(([action]) => action === 'authorize')?.[1] as Record<string, unknown>;
    expect(permit.action).toBe(operation.action); expect(permit.resource).toBe(operation.resource);
    expect(permit.contentDigest).toBe(createHash('sha256').update(operation.body).digest('base64url'));
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('cannot execute after logout, disconnect or venue denial during permission preparation', async () => {
    for (const end of ['logout', 'abort', 'venue'] as const) {
      const f = cocoiruAuthority(), created = await f.create(), controller = new AbortController(), execute = vi.fn();
      let venue = true;
      f.control.beforeCall = async action => {
        if (action !== 'consume') return;
        if (end === 'logout') await f.store.revoke(created.sessionToken);
        if (end === 'abort') controller.abort();
        if (end === 'venue') venue = false;
      };
      await expect(f.store.run(created.sessionToken, operation, controller.signal, () => venue, execute)).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
      expect(f.call.mock.calls.filter(([action]) => action === 'consume')).toHaveLength(1);
    }
  });
  it('does not cache a positive grant or retry an uncertain authority call', async () => {
    for (const status of [401, 503]) {
      const f = cocoiruAuthority(), created = await f.create(), execute = vi.fn();
      f.control.beforeCall = action => { if (action === 'check') throw new CompositeAuthorityError(status); };
      await expect(f.store.run(created.sessionToken, operation, new AbortController().signal, () => true, execute)).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
      expect(f.call.mock.calls.map(([action]) => action)).toEqual(['bind', 'check']);
    }
  });
  it('claims capacity before exchange and cannot publish after close or disconnect during bind', async () => {
    const bounded = cocoiruAuthority(1);
    await bounded.create();
    await expect(bounded.create()).rejects.toThrow('capacity');
    expect(bounded.authority.exchange).toHaveBeenCalledTimes(1);
    for (const end of ['close', 'abort'] as const) {
      const f = cocoiruAuthority(), controller = new AbortController();
      f.control.beforeCall = action => { if (action === 'bind') { if (end === 'close') f.store.close(); else controller.abort(); } };
      await expect(f.store.create(opaque(), opaque(), controller.signal)).rejects.toThrow();
      expect(f.call.mock.calls.filter(([action]) => action === 'revoke')).toHaveLength(1);
    }
  });
  it('deletes local authority before an unconfirmed remote logout', async () => {
    const f = cocoiruAuthority(), created = await f.create(), execute = vi.fn();
    f.control.beforeCall = action => { if (action === 'revoke') throw new Error('Unconfirmed'); };
    await expect(f.store.revoke(created.sessionToken)).rejects.toThrow();
    await expect(f.store.run(created.sessionToken, operation, new AbortController().signal, () => true, execute)).rejects.toBeInstanceOf(CocoiruSessionError);
    expect(execute).not.toHaveBeenCalled();
  });
});
describe('native startup contract', () => {
  it('leaves the optional route absent, but enabling it cannot use a static token or incomplete registration', () => {
    expect(cocoiruNativeConfig({}, false)).toBeNull();
    const env = { OSTIARIUS_COCOIRU_LAN_INTERFACE: 'venue', OSTIARIUS_PWA_ORIGIN: 'https://os.example', CERNERE_PROJECT_KEY: 'ostiarius',
      CERNERE_PROJECT_CLIENT_ID: 'ostiarius', CERNERE_PROJECT_CLIENT_SECRET: opaque() };
    expect(cocoiruNativeConfig(env, true)?.projectKey).toBe('ostiarius');
    expect(() => cocoiruNativeConfig(env, false)).toThrow();
    for (const key of ['CERNERE_PROJECT_KEY', 'CERNERE_PROJECT_CLIENT_ID', 'CERNERE_PROJECT_CLIENT_SECRET']) {
      expect(() => cocoiruNativeConfig({ ...env, [key]: '', CERNERE_SERVICE_TOKEN: opaque() }, true)).toThrow();
    }
    for (const origin of ['http://os.example', 'https://os.example/', 'https://user@os.example', 'https://os.example?query', 'https://os.example#fragment']) {
      expect(() => cocoiruNativeConfig({ ...env, OSTIARIUS_PWA_ORIGIN: origin }, true)).toThrow();
    }
  });
});
