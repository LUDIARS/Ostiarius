import { X509Certificate } from 'node:crypto';

export interface RenewalDecision {
  reason: 'certificate_missing' | 'certificate_invalid' | 'renewal_window' | 'already_valid';
  shouldRenew: boolean;
}

/** Decides renewal from public certificate metadata without performing any I/O. */
export function decideRenewal(
  certificatePem: string | null,
  renewBeforeDays: number,
  now: Date = new Date(),
): RenewalDecision {
  if (!certificatePem) {
    return { shouldRenew: true, reason: 'certificate_missing' };
  }

  try {
    const certificate = new X509Certificate(certificatePem);
    const expiresAt = Date.parse(certificate.validTo);
    const renewAt = now.getTime() + renewBeforeDays * 24 * 60 * 60 * 1000;

    if (!Number.isFinite(expiresAt)) {
      return { shouldRenew: true, reason: 'certificate_invalid' };
    }

    return expiresAt <= renewAt
      ? { shouldRenew: true, reason: 'renewal_window' }
      : { shouldRenew: false, reason: 'already_valid' };
  } catch {
    return { shouldRenew: true, reason: 'certificate_invalid' };
  }
}
