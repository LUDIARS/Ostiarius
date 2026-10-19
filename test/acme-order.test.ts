import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  finalize: vi.fn(), download: vi.fn(), write: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('account-key'), mkdir: vi.fn(),
  writeFile: mocks.write, chmod: vi.fn(),
}));
vi.mock('acme-client', () => ({
  crypto: { createCsr: vi.fn().mockResolvedValue(['private-key', 'csr']) },
  Client: class {
    createAccount = vi.fn();
    createOrder = vi.fn().mockResolvedValue({ status: 'ready', url: 'order-url', finalize: 'finalize-url' });
    getAuthorizations = vi.fn().mockResolvedValue([]);
    finalizeOrder = mocks.finalize;
    getCertificate = mocks.download;
  },
}));
vi.mock('../server/acme/cloudflare-dns.ts', () => ({ CloudflareDnsClient: class {} }));
import { issueCertificate } from '../server/acme/order.ts';

beforeEach(() => { vi.clearAllMocks(); });
it.each(['valid', 'processing'])('downloads using the finalized %s order, not a stale ready order', async (status) => {
  const finalized = { status, url: 'order-url', ...(status === 'valid' ? { certificate: 'certificate-url' } : {}) };
  mocks.finalize.mockResolvedValue(finalized);
  mocks.download.mockImplementation(async (order) => {
    if (order.status === 'ready') throw new Error('Unable to download certificate, URL not found');
    expect(order).toBe(finalized);
    return 'certificate-pem';
  });
  await issueCertificate({ accountKeyPath: 'account.key', cloudflareToken: 'test-token', directoryUrl: 'https://ca.example/directory', email: 'ops@example.com', hostname: 'lan.example.com', outputDir: 'certs' });
  expect(mocks.download).toHaveBeenCalledExactlyOnceWith(finalized);
  expect(mocks.write).toHaveBeenCalledWith(expect.stringContaining('fullchain.pem'), 'certificate-pem', expect.any(Object));
});
