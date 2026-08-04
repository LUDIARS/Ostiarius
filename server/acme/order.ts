import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as acme from 'acme-client';
import { CloudflareDnsClient, type CreatedTxtRecord } from './cloudflare-dns.ts';

export const LETS_ENCRYPT_PRODUCTION_DIRECTORY = 'https://acme-v02.api.letsencrypt.org/directory';
export const LETS_ENCRYPT_STAGING_DIRECTORY = 'https://acme-staging-v02.api.letsencrypt.org/directory';

export interface AcmeIssueOptions {
  accountKeyPath: string;
  cloudflareToken: string;
  directoryUrl: string;
  email: string;
  hostname: string;
  outputDir: string;
}

async function loadOrCreateAccountKey(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // createPrivateRsaKey は Buffer (PEM のバイト列) を返す。
    const key = (await acme.crypto.createPrivateRsaKey()).toString();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, key, { encoding: 'utf8', mode: 0o600 });
    return key;
  }
}

/** Issues a DNS-01 certificate and writes only local PEM artifacts; it never updates Infisical. */
export async function issueCertificate(options: AcmeIssueOptions): Promise<void> {
  const accountKey = await loadOrCreateAccountKey(options.accountKeyPath);
  const client = new acme.Client({ directoryUrl: options.directoryUrl, accountKey });
  await client.createAccount({ termsOfServiceAgreed: true, contact: [`mailto:${options.email}`] });

  const [privateKey, csr] = await acme.crypto.createCsr({ commonName: options.hostname, altNames: [options.hostname] });
  const order = await client.createOrder({ identifiers: [{ type: 'dns', value: options.hostname }] });
  const dnsClient = new CloudflareDnsClient({ apiToken: options.cloudflareToken });
  const createdRecords: CreatedTxtRecord[] = [];

  try {
    for (const authorization of await client.getAuthorizations(order)) {
      // TXT は「その authorization の identifier」に対して張る。order の hostname を使うと
      // identifier が増えたとき (altNames / wildcard) 別名の challenge を解けない。
      const identifier = authorization.identifier.value;
      const challenge = authorization.challenges.find((candidate) => candidate.type === 'dns-01');
      if (!challenge) throw new Error(`ACME did not offer a DNS-01 challenge for ${identifier}`);
      // getChallengeKeyAuthorization は dns-01 のとき base64url(sha256(token.thumbprint)) を
      // 既に返す (RFC 8555 §8.4)。ここで再度 sha256 すると TXT 値が二重ハッシュになり、
      // challenge は必ず invalid になる。そのまま TXT に載せる。
      const dnsValue = await client.getChallengeKeyAuthorization(challenge);
      const record = await dnsClient.createTxtRecord(identifier, dnsValue);
      createdRecords.push(record);
      await dnsClient.waitForTxtPropagation(record.name, dnsValue);
      await client.verifyChallenge(authorization, challenge);
      await client.completeChallenge(challenge);
      await client.waitForValidStatus(challenge);
    }

    await client.finalizeOrder(order, csr);
    const fullchain = await client.getCertificate(order);
    await mkdir(options.outputDir, { recursive: true });
    await writeFile(join(options.outputDir, 'fullchain.pem'), fullchain, { encoding: 'utf8', mode: 0o644 });
    // Windows has no POSIX mode enforcement; data/acme/ is gitignored to prevent secret-key commits.
    // writeFile の mode は「新規作成時」しか効かない。再発行で既存の緩いパーミッションを
    // 引き継がないよう、書き込み後に明示的に締め直す。
    const privateKeyPath = join(options.outputDir, 'privkey.pem');
    await writeFile(privateKeyPath, privateKey, { encoding: 'utf8', mode: 0o600 });
    await chmod(privateKeyPath, 0o600);
  } finally {
    // 後始末の失敗で本来の発行エラーを握り潰さない (finally の throw は元の例外を置き換える)。
    // 残った TXT は ttl 120s の使い捨てなので、警告だけ出して続行する。
    const cleanups = await Promise.allSettled(createdRecords.map((record) => dnsClient.deleteTxtRecord(record)));
    cleanups.forEach((cleanup, index) => {
      if (cleanup.status !== 'rejected') return;
      const name = createdRecords[index]?.name ?? 'unknown record';
      const reason = cleanup.reason instanceof Error ? cleanup.reason.message : 'unknown error';
      process.stderr.write(`Failed to delete ACME TXT record ${name}: ${reason}\n`);
    });
  }
}
