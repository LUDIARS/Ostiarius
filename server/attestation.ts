// Attestation の型 + 署名/検証ヘルパ。
//
// 形式 (CONTRACTS.md §1 / spike shared.ts と完全一致):
//   attestation = base64url(JSON payload) + "." + base64url(Ed25519 署名)
//
// ゲートウェイの永続 Ed25519 秘密鍵で署名し、 Aedilis が `lanId` で引く
// ゲートウェイ公開鍵 (SPKI PEM) で検証する。 この形式を変えると Aedilis 側の
// 検証が破綻するため、 payload のフィールド・順序・エンコードは固定。

import { sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';

export interface AttestationPayload {
  sub: string; // Cernere user id (assertion で確定した本人)
  placeId: string; // = facilityId。 出席対象の施設/部屋
  lanId: string; // 発行ゲートウェイ ID (Aedilis が公開鍵を引くキー)
  nonce: string; // 検証に使った challenge (base64url)。 replay 検出用
  issuedAt: number; // epoch ms。 出席時刻の正本 (ゲートウェイ時計)
}

export function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function signAttestation(payload: AttestationPayload, privateKey: KeyObject): string {
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload)));
  const sig = cryptoSign(null, Buffer.from(body), privateKey);
  return `${body}.${b64urlEncode(sig)}`;
}

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
