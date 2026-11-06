// 送信経路ごとの purpose の取り違えを、送る前に検出する
// (spec/feature/venue-registration.md §3、onsite-mfa-factor.md §3)。
//
// - 出席 (Aedilis) へは attendance だけを送る。
// - 現地確認 MFA (Cernere) へは mfa だけを送る。
// - 会場登録 (Cernere) へは registration だけを送る。
//
// payload を読めない文字列は受け手の署名検証に任せる (ここでは null = 取り違えなし)。
// purpose が欠落した旧形式は attendance として読む (attestationPurpose)。

import { attestationPurpose, b64urlDecode, type AttestationPurpose } from './attestation.ts';
import { contract } from '../contract-runtime.ts'; /* augur-inject:import:a7e4ccd2 */
import augurContract_ce131389 from '../contracts/foreign-attestation-purpose.contract.ts'; /* augur-inject:contract-predicate:6706be73 */

function readPurpose(attestation: string): AttestationPurpose | null {
  const [body, sig] = attestation.split('.');
  if (!body || !sig) return null;
  try {
    const payload: unknown = JSON.parse(b64urlDecode(body).toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    const purpose = (payload as { purpose?: unknown }).purpose;
    if (purpose !== undefined && typeof purpose !== 'string') return null;
    return attestationPurpose({ purpose: purpose as AttestationPurpose | undefined });
  } catch {
    return null;
  }
}

/** 読み取れる purpose が expected と違えばその purpose、同じか読めなければ null。 */
export function foreignAttestationPurpose(attestation: string, expected: AttestationPurpose): AttestationPurpose | null {
  const purpose = readPurpose(attestation);
  return purpose !== null && purpose !== expected ? purpose : null;
}
// @ts-expect-error augur-inject
foreignAttestationPurpose = contract(foreignAttestationPurpose, { ...augurContract_ce131389, contractId: 'C-27', mode: 'observe', sample: 1, where: 'server/attestation-purpose-guard.ts:28', rule: 'contract-wrap', id: 'ce131389' }); /* augur-inject:contract-wrap:ce131389 */
