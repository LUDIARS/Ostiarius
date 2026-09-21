import { describe, expect, it } from 'vitest';
import { resolveTlsConfig } from '../server/tls-config.ts';

describe('Ostiarius TLS configuration', () => {
  it('keeps local development HTTP explicit', () => {
    expect(resolveTlsConfig({ OSTIARIUS_TLS_MODE: 'off' })).toEqual({ enabled: false });
  });

  it('requires hostname, certificate, and private key together', () => {
    expect(() => resolveTlsConfig({ OSTIARIUS_TLS_MODE: 'required' })).toThrow(
      /OSTIARIUS_LAN_HOSTNAME.*OSTIARIUS_TLS_CERTIFICATE_PEM.*OSTIARIUS_TLS_PRIVATE_KEY_PEM/,
    );
  });

  it('returns the complete HTTPS configuration without logging secrets', () => {
    expect(resolveTlsConfig({
      OSTIARIUS_TLS_MODE: 'required',
      OSTIARIUS_LAN_HOSTNAME: 'ostiarius.example.test',
      OSTIARIUS_TLS_CERTIFICATE_PEM: 'certificate-pem',
      OSTIARIUS_TLS_PRIVATE_KEY_PEM: 'private-key-pem',
    })).toEqual({
      enabled: true,
      hostname: 'ostiarius.example.test',
      certificatePem: 'certificate-pem',
      privateKeyPem: 'private-key-pem',
    });
  });

  it('rejects a hostname containing a scheme, port, or path', () => {
    expect(() => resolveTlsConfig({
      OSTIARIUS_TLS_MODE: 'required',
      OSTIARIUS_LAN_HOSTNAME: 'https://ostiarius.example.test/path',
      OSTIARIUS_TLS_CERTIFICATE_PEM: 'certificate-pem',
      OSTIARIUS_TLS_PRIVATE_KEY_PEM: 'private-key-pem',
    })).toThrow(/DNS hostname/);
  });
});
