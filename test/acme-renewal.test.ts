import { describe, expect, it } from 'vitest';
import { decideRenewal } from '../server/acme/renewal.ts';

const certificatePem = `-----BEGIN CERTIFICATE-----
MIIDDzCCAfegAwIBAgIUJOPrUuWiArHWyf/dUUxP4s97L60wDQYJKoZIhvcNAQEL
BQAwFzEVMBMGA1UEAwwMcmVuZXdhbC50ZXN0MB4XDTI2MDgwMzEyNDExN1oXDTM2
MDczMTEyNDExN1owFzEVMBMGA1UEAwwMcmVuZXdhbC50ZXN0MIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxwiYMbS7m4xtyXIB+xqvhNOfthhgQMqqCm+0
BliiIooCcdxkTY/Jw1KYQdm2zmaNvZN+ryDBSOzRf5GBtehHahgB9JuiCWvFY7p9
6wHMflwrUpQfA3SGRycb7VyQWTo0F4oIl7GJ1q2ml7jIoEOigps+E9lyVTGLtSce
NA+GHgw/fi4PsmIgpFcuWmmw8gSsahB2K9Rsaidcct7h6rTwCD+BDaXJhdlQ31DQ
zuJitpYlfXsMNto+4A9zShhFXVFYGILeA+zcr8N3p+MXvxwqnri6jVwesXK/KLmo
lGGWSbVqzjfRShASccfXOZ8pBTqsgp3tyzdAwoXbdTNTUN9LiQIDAQABo1MwUTAd
BgNVHQ4EFgQUS3L2nlKBE18QXkIx6bwufi7wBcswHwYDVR0jBBgwFoAUS3L2nlKB
E18QXkIx6bwufi7wBcswDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOC
AQEATmCPmCEsPIiNmbya+45hfe+z7W1/H4ZnMDxHq9qASsc4ZT3Wg29V8yGjJebX
aKueJ0xso/FGJ6UhwpEL4Xy78dpCfTUILykJ37dzRjNvLt0F3r709Rs0BqtiVlig
MFKM9myX5fR4cP6Urq6ZR6D8kK/qaYUruZD2f4+v4e5n5RuGlGEkgGaWUHHKmQWT
Qf4OOZlAPLqc01UJWKqbcdmoP+Hcd/W1uJWQH6pc/e8L+SIrUyRu76GCHu/u7Vki
nDeXgo7OygJ6iPZSmgrYGeEonD6CghY3ucRA98z7O1rGsWV24c+YlakKiZQ0YGU9
vMZ4rzoqHGOKHHgE1scNRUrIRg==
-----END CERTIFICATE-----`;

describe('decideRenewal', () => {
  it('does not renew a certificate beyond the renewal threshold', () => {
    expect(decideRenewal(certificatePem, 30, new Date('2026-08-03T00:00:00Z'))).toEqual({
      shouldRenew: false,
      reason: 'already_valid',
    });
  });

  it('renews a certificate inside the renewal threshold', () => {
    expect(decideRenewal(certificatePem, 30, new Date('2036-07-15T00:00:00Z'))).toEqual({
      shouldRenew: true,
      reason: 'renewal_window',
    });
  });

  it('treats invalid PEM as requiring renewal with a reason', () => {
    expect(decideRenewal('not a certificate', 30)).toEqual({ shouldRenew: true, reason: 'certificate_invalid' });
  });
});
