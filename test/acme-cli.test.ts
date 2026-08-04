import { describe, expect, it } from 'vitest';
import { resolveCliConfig } from '../server/acme/cli.ts';

describe('ACME CLI configuration', () => {
  it('lists all missing required environment keys before making network requests', () => {
    expect(() => resolveCliConfig(['issue'], {})).toThrow(
      'CLOUDFLARE_DNS_API_TOKEN, OSTIARIUS_LAN_HOSTNAME, OSTIARIUS_ACME_EMAIL',
    );
  });

  it('allows CLI values to override environment values', () => {
    const config = resolveCliConfig(
      ['renew', '--hostname', 'override.example.com', '--directory', 'staging'],
      {
        CLOUDFLARE_DNS_API_TOKEN: 'token',
        OSTIARIUS_ACME_EMAIL: 'ops@example.com',
        OSTIARIUS_LAN_HOSTNAME: 'env.example.com',
      },
    );
    expect(config.hostname).toBe('override.example.com');
    expect(config.directoryUrl).toContain('staging');
  });

  it('treats blank values as unset instead of producing empty paths or a zero renewal window', () => {
    const config = resolveCliConfig(['issue'], {
      CLOUDFLARE_DNS_API_TOKEN: ' token\n',
      OSTIARIUS_ACME_EMAIL: 'ops@example.com',
      OSTIARIUS_ACME_OUTPUT_DIR: '   ',
      OSTIARIUS_ACME_RENEW_BEFORE_DAYS: '',
      OSTIARIUS_LAN_HOSTNAME: 'env.example.com',
    });
    expect(config.outputDir).toBe('data/acme');
    expect(config.renewBeforeDays).toBe(30);
    expect(config.cloudflareToken).toBe('token');
  });

  it('rejects unknown CLI options instead of ignoring them', () => {
    expect(() => resolveCliConfig(['issue', '--unknown', 'value'], {})).toThrow('Invalid CLI option: --unknown');
  });
});
