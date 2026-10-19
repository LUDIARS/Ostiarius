import { expect, it } from 'vitest';
import { resolveLanHttpsPort } from '../server/lan-https-port.ts';
import { isAllowedHost, createAllowedHostsResolver } from '../server/http-security/host-allowlist.ts';

it('retains the single listener when no separate port is selected', () => {
  expect(resolveLanHttpsPort(undefined, 17590, false)).toBeNull();
  expect(resolveLanHttpsPort(undefined, 17590, true)).toBeNull();
});
it('requires TLS and a distinct valid port', () => {
  expect(resolveLanHttpsPort('17592', 17590, true)).toBe(17592);
  expect(() => resolveLanHttpsPort('17592', 17590, false)).toThrow();
  for (const value of ['0', '65536', '17590', 'NaN', '1.5']) {
    expect(() => resolveLanHttpsPort(value, 17590, true)).toThrow();
  }
});
it('allows only enrolled hostnames and listener ports', () => {
  const allowed = createAllowedHostsResolver({ port: 17590, additionalPorts: [17592], lanHostname: 'lan.example.com', detectAddresses: () => [] })();
  expect(isAllowedHost('localhost:17590', allowed)).toBe(true);
  expect(isAllowedHost('lan.example.com:17592', allowed)).toBe(true);
  expect(isAllowedHost('lan.example.com:17593', allowed)).toBe(false);
  expect(isAllowedHost('attacker.example:17592', allowed)).toBe(false);
});
