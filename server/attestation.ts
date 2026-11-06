// Attestation の型 + 署名/検証ヘルパ。
//
// 形式 (CONTRACTS.md §1 / spike shared.ts と完全一致):
//   attestation = base64url(JSON payload) + "." + base64url(Ed25519 署名)
//
// ゲートウェイの永続 Ed25519 秘密鍵で署名し、 Aedilis (出席) / Cernere (現地確認 MFA) が
// ゲートウェイ公開鍵 (SPKI PEM) で検証する。 この形式を変えると受け手の検証が破綻するため、
// payload のフィールド・順序・エンコードは固定:
//   { sub, placeId, lanId, nonce, issuedAt, method, assurance, purpose }
// purpose は末尾追加 (spec/feature/onsite-mfa-factor.md §3)。 欠落した旧形式は attendance。
// purpose "location" は位置の宣言 (server/location-statement.ts) 専用で、payload の形が違う
// (spec/feature/gps-location-statement.md)。受け手は出席・MFA の attestation として受理しない。
// purpose "registration" は会場ネットワーク限定の新規登録 (spec/feature/venue-registration.md)。
// 本人確認をしないので sub は null で、method "lan" / assurance "network" に固定する。
// 出席 (Aedilis) と MFA の経路はこの purpose を作らず、送らない (attestation-purpose-guard.ts)。

import { sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { contract } from '../contract-runtime.ts'; /* augur-inject:import:7d9d6302 */
import augurContract_4ac07e6b from '../contracts/sign-attestation.contract.ts'; /* augur-inject:contract-predicate:bdbc477a */
import augurContract_ebb55281 from '../contracts/attestation-purpose.contract.ts'; /* augur-inject:contract-predicate:7fc5e03b */

export interface AttestationPayload {
  sub: string | null; // Cernere user id (assertion で確定した本人)。会場登録だけ null
  placeId: string; // = facilityId。 出席対象の施設/部屋
  lanId: string; // 発行ゲートウェイ ID (Aedilis が公開鍵を引くキー)
  nonce: string; // 検証に使った challenge (base64url)。 replay 検出用
  issuedAt: number; // epoch ms。 出席時刻の正本 (ゲートウェイ時計)
  /** P1 以降の本人確認手段。旧5フィールドの署名済み payload を読むため optional。 */
  method?: AttestationMethod;
  /** P1 以降の保証水準。旧5フィールドの署名済み payload を読むため optional。 */
  assurance?: AttestationAssurance;
  /** 用途。purpose 導入前の署名済み payload を読むため optional (欠落 = attendance)。 */
  purpose?: AttestationPurpose;
}

export type AttestationMethod = 'face' | 'face_passive' | 'passkey' | 'staff_override' | 'session' | 'password' | 'lan';
export type AttestationAssurance = 'high' | 'medium' | 'manual' | 'low' | 'network';
export type AttestationPurpose = 'attendance' | 'mfa' | 'location' | 'registration';

/** 本人を確定した attestation (出席・MFA)。発行側は method / assurance / purpose を必ず明示する。 */
export type SubjectAttestation = Required<AttestationPayload> & {
  sub: string;
  method: Exclude<AttestationMethod, 'lan'>;
  assurance: Exclude<AttestationAssurance, 'network'>;
  purpose: Exclude<AttestationPurpose, 'registration' | 'location'>;
};

/** 会場ネットワーク限定の新規登録。本人確認をしないので sub は null、確度は network に固定。 */
export interface RegistrationAttestation {
  sub: null;
  placeId: string;
  lanId: string;
  nonce: string;
  issuedAt: number;
  method: 'lan';
  assurance: 'network';
  purpose: 'registration';
}

/** 新しく署名する payload。 */
export type SignableAttestation = SubjectAttestation | RegistrationAttestation;

/** payload のキー順。JSON.stringify は挿入順なので、この順で組み直してから署名する。 */
export const ATTESTATION_FIELD_ORDER = ['sub', 'placeId', 'lanId', 'nonce', 'issuedAt', 'method', 'assurance', 'purpose'] as const;

export function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** purpose の読み取り。欠落した旧形式は出席用とみなす。 */
export function attestationPurpose(payload: Pick<AttestationPayload, 'purpose'>): AttestationPurpose {
  return payload.purpose ?? 'attendance';
}
// @ts-expect-error augur-inject
attestationPurpose = contract(attestationPurpose, { ...augurContract_ebb55281, contractId: 'C-11', mode: 'observe', sample: 1, where: 'server/attestation.ts:47', rule: 'contract-wrap', id: 'ebb55281' }); /* augur-inject:contract-wrap:ebb55281 */

/** 判別共用体のどちらでも、キー順だけを固定した同じ値を返す。 */
function canonicalPayload<T extends SignableAttestation>(payload: T): T {
  return {
    sub: payload.sub,
    placeId: payload.placeId,
    lanId: payload.lanId,
    nonce: payload.nonce,
    issuedAt: payload.issuedAt,
    method: payload.method,
    assurance: payload.assurance,
    purpose: payload.purpose,
  } as T;
}

/** 組み直し済みの payload を `base64url(JSON) + "." + base64url(Ed25519 署名)` にする。 */
export function signCompactPayload(payload: object, privateKey: KeyObject): string {
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload)));
  const sig = cryptoSign(null, Buffer.from(body), privateKey);
  return `${body}.${b64urlEncode(sig)}`;
}

export function signAttestation(payload: SignableAttestation, privateKey: KeyObject): string {
  return signCompactPayload(canonicalPayload(payload), privateKey);
}
// @ts-expect-error augur-inject
signAttestation = contract(signAttestation, { ...augurContract_4ac07e6b, contractId: 'C-10', mode: 'observe', sample: 1, where: 'server/attestation.ts:64', rule: 'contract-wrap', id: '4ac07e6b' }); /* augur-inject:contract-wrap:4ac07e6b */

export function verifyAttestation(
  token: string,
  publicKey: KeyObject,
): { ok: boolean; payload?: AttestationPayload } {
  const [body, sig] = token.split('.');
  if (!body || !sig) return { ok: false };
  const ok = cryptoVerify(null, Buffer.from(body), publicKey, b64urlDecode(sig));
  if (!ok) return { ok: false };
  return { ok: true, payload: JSON.parse(b64urlDecode(body).toString('utf8')) as AttestationPayload };
}
