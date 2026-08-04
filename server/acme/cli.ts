import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { issueCertificate, LETS_ENCRYPT_PRODUCTION_DIRECTORY, LETS_ENCRYPT_STAGING_DIRECTORY } from './order.ts';
import { decideRenewal } from './renewal.ts';

type Command = 'issue' | 'renew';

export interface CliConfig {
  accountKeyPath: string;
  cloudflareToken: string;
  command: Command;
  directoryUrl: string;
  email: string;
  hostname: string;
  outputDir: string;
  renewBeforeDays: number;
}

const optionToEnv = {
  '--account-key-path': 'OSTIARIUS_ACME_ACCOUNT_KEY_PATH',
  '--directory': 'OSTIARIUS_ACME_DIRECTORY',
  '--email': 'OSTIARIUS_ACME_EMAIL',
  '--hostname': 'OSTIARIUS_LAN_HOSTNAME',
  '--output-dir': 'OSTIARIUS_ACME_OUTPUT_DIR',
  '--renew-before-days': 'OSTIARIUS_ACME_RENEW_BEFORE_DAYS',
  '--token': 'CLOUDFLARE_DNS_API_TOKEN',
} as const;

function parseOverrides(args: string[]): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index] as keyof typeof optionToEnv | undefined;
    const value = args[index + 1];
    if (!option || !(option in optionToEnv) || value === undefined || value.startsWith('--')) {
      throw new Error(`Invalid CLI option: ${args[index] ?? ''}`);
    }
    overrides[optionToEnv[option]] = value;
  }
  return overrides;
}

function directoryUrl(value: string | undefined): string {
  if (!value || value === 'production') return LETS_ENCRYPT_PRODUCTION_DIRECTORY;
  if (value === 'staging') return LETS_ENCRYPT_STAGING_DIRECTORY;
  return value;
}

export function resolveCliConfig(args: string[], env: NodeJS.ProcessEnv = process.env): CliConfig {
  const command = args[0];
  if (command !== 'issue' && command !== 'renew') {
    throw new Error('Usage: tls:issue | tls:renew [--hostname <fqdn> ...]');
  }
  const values = { ...env, ...parseOverrides(args.slice(1)) };
  // 空文字 / 空白のみの env は「未設定」と同じに扱う (`?? default` は空文字を素通しし、
  // outputDir='' や renewBeforeDays=Number('')=0 を静かに作ってしまう)。
  // token をそのまま Authorization に載せると、末尾改行だけで fetch が例外になる。
  const value = (key: string): string | undefined => values[key]?.trim() || undefined;
  const required = ['CLOUDFLARE_DNS_API_TOKEN', 'OSTIARIUS_LAN_HOSTNAME', 'OSTIARIUS_ACME_EMAIL'] as const;
  const missing = required.filter((key) => !value(key));
  if (missing.length > 0) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);

  const renewBeforeDays = Number(value('OSTIARIUS_ACME_RENEW_BEFORE_DAYS') ?? '30');
  if (!Number.isFinite(renewBeforeDays) || renewBeforeDays < 0) {
    throw new Error('OSTIARIUS_ACME_RENEW_BEFORE_DAYS must be a non-negative number');
  }
  return {
    accountKeyPath: value('OSTIARIUS_ACME_ACCOUNT_KEY_PATH') ?? 'data/acme/account.key',
    cloudflareToken: value('CLOUDFLARE_DNS_API_TOKEN')!,
    command,
    directoryUrl: directoryUrl(value('OSTIARIUS_ACME_DIRECTORY')),
    email: value('OSTIARIUS_ACME_EMAIL')!,
    hostname: value('OSTIARIUS_LAN_HOSTNAME')!,
    outputDir: value('OSTIARIUS_ACME_OUTPUT_DIR') ?? 'data/acme',
    renewBeforeDays,
  };
}

export async function runCli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const config = resolveCliConfig(args, env);
  if (config.command === 'renew') {
    let certificatePem: string | null = null;
    try {
      certificatePem = await readFile(join(config.outputDir, 'fullchain.pem'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const decision = decideRenewal(certificatePem, config.renewBeforeDays);
    if (!decision.shouldRenew) return 'already valid';
  }
  await issueCertificate(config);
  return 'Certificate issued. Register these Infisical environment names: OSTIARIUS_TLS_CERTIFICATE_PEM, OSTIARIUS_TLS_PRIVATE_KEY_PEM, OSTIARIUS_TLS_MODE=required';
}

async function main(): Promise<void> {
  try {
    process.stdout.write(`${await runCli(process.argv.slice(2))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'ACME issuance failed'}\n`);
    process.exitCode = 1;
  }
}

// Windows のパス (E:\...) は file:// を単純連結しても import.meta.url と一致しない。
// pathToFileURL を通さないと CLI が黙って何もせず exit 0 になる。
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) void main();
