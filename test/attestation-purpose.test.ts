import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';

import {
  attestationPurpose,
  b64urlDecode,
  b64urlEncode,
  signAttestation,
  verifyAttestation,
  type SignableAttestation,
} from '../server/attestation.ts';

const BASE: SignableAttestation = {
  sub: 'user-1',
  placeId: 'room-1',
  lanId: 'lan-1',
  nonce: 'nonce-1',
  issuedAt: 1_700_000_000_000,
  method: 'face',
  assurance: 'high',
  purpose: 'mfa',
};

function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(b64urlDecode(token.split('.')[0] ?? '').toString('utf8')) as Record<string, unknown>;
}

describe('attestation purpose (onsite-mfa-factor §3)', () => {
  it('signs the payload in the fixed key order with purpose last', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    // 呼び出し側のキー順が違っても、署名する payload は固定順に組み直す。
    const shuffled = { purpose: 'mfa', assurance: 'high', method: 'face', issuedAt: BASE.issuedAt, nonce: 'nonce-1', lanId: 'lan-1', placeId: 'room-1', sub: 'user-1' } as SignableAttestation;
    const token = signAttestation(shuffled, privateKey);
    expect(Object.keys(decodePayload(token))).toEqual(['sub', 'placeId', 'lanId', 'nonce', 'issuedAt', 'method', 'assurance', 'purpose']);
    const verified = verifyAttestation(token, publicKey);
    expect(verified.ok).toBe(true);
    expect(verified.payload?.purpose).toBe('mfa');
  });

  it('covers purpose with the signature so rewriting it fails verification', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const token = signAttestation(BASE, privateKey);
    const [, signature] = token.split('.');
    const rewritten = b64urlEncode(Buffer.from(JSON.stringify({ ...decodePayload(token), purpose: 'attendance' })));
    expect(verifyAttestation(`${rewritten}.${signature}`, publicKey).ok).toBe(false);
  });

  it('reads a legacy payload without purpose as attendance', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    // purpose 導入前の 7 フィールド形式をそのまま署名したもの。
    const legacy = { sub: 'user-1', placeId: 'room-1', lanId: 'lan-1', nonce: 'n', issuedAt: 1, method: 'passkey', assurance: 'medium' };
    const body = b64urlEncode(Buffer.from(JSON.stringify(legacy)));
    const token = `${body}.${b64urlEncode(sign(null, Buffer.from(body), privateKey))}`;
    const verified = verifyAttestation(token, publicKey);
    expect(verified.ok).toBe(true);
    expect(verified.payload?.purpose).toBeUndefined();
    expect(attestationPurpose(verified.payload!)).toBe('attendance');
  });

  it('returns an explicit purpose verbatim', () => {
    expect(attestationPurpose({ purpose: 'mfa' })).toBe('mfa');
    expect(attestationPurpose({ purpose: 'attendance' })).toBe('attendance');
  });
});
