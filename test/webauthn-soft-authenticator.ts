// テスト用ソフトウェア WebAuthn authenticator (ES256 / P-256)。
//
// 「生体タップ」= プラットフォーム authenticator (Windows Hello / Touch ID 等) が
// 行う assertion 生成を、 実機なしで再現するためのテストダブル。 OS の生体 UI を
// 介さずに、 既知の P-256 鍵で WebAuthn assertion を組み立て・署名する。
//
//   - 公開鍵は COSE_Key (EC2/ES256) でエンコードする (Cernere export → Ostiarius
//     同期で格納される `public_key` (base64 COSE) と同形式)。
//   - assertion は @simplewebauthn/server の verifyAuthenticationResponse が
//     そのまま検証できる形 (clientDataJSON / authenticatorData / DER 署名) で返す。
//
// これは「生体そのもの」の代替ではない (実機 UV の OS 統合は別物)。 あくまで
// 「正しい鍵で UV 付き assertion が来たとき、 Ostiarius の検証 → attestation 発行が
// 通るか」 を自動で確かめるためのもの。 実機での生体タップは runbook 側で扱う。

import {
  createSign,
  generateKeyPairSync,
  createHash,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** EC2/ES256 の COSE_Key を手で組む (RFC 8152)。
 *  map{ 1:2(kty EC2), 3:-7(alg ES256), -1:1(crv P-256), -2:x(32B), -3:y(32B) } */
function coseEc2PublicKey(x: Buffer, y: Buffer): Buffer {
  if (x.length !== 32 || y.length !== 32) {
    throw new Error(`P-256 coord length must be 32 (x=${x.length} y=${y.length})`);
  }
  return Buffer.concat([
    Buffer.from([0xa5]), // map(5)
    Buffer.from([0x01, 0x02]), //  1 (kty)  : 2 (EC2)
    Buffer.from([0x03, 0x26]), //  3 (alg)  : -7 (ES256)
    Buffer.from([0x20, 0x01]), // -1 (crv)  : 1 (P-256)
    Buffer.from([0x21, 0x58, 0x20]), x, // -2 (x) : bstr(32)
    Buffer.from([0x22, 0x58, 0x20]), y, // -3 (y) : bstr(32)
  ]);
}

export interface SoftAuthenticator {
  /** WebAuthn credential.id (base64url)。 Ostiarius の credential_id に一致させる。 */
  credentialId: string;
  /** 公開鍵 (base64 COSE)。 Ostiarius credentials.public_key に格納する値。 */
  publicKeyCoseBase64: string;
  /** Ostiarius の begin が返した options.challenge に対して assertion を作る。 */
  buildAssertion(challenge: string, origin: string, rpId: string): AuthenticationResponseJSON;
}

/** P-256 鍵を新規生成したソフト authenticator を返す。 */
export function createSoftAuthenticator(opts?: { userHandle?: string }): SoftAuthenticator {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');

  const credentialIdBytes = randomBytes(20);
  const credentialId = b64url(credentialIdBytes);
  const publicKeyCoseBase64 = coseEc2PublicKey(x, y).toString('base64');
  const userHandle = opts?.userHandle;

  // 署名カウンタは単調増加させる (Ostiarius は best-effort で前進のみ採用)。
  let signCount = 0;

  return {
    credentialId,
    publicKeyCoseBase64,
    buildAssertion(challenge: string, origin: string, rpId: string): AuthenticationResponseJSON {
      const clientData = JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false });
      const clientDataJSON = Buffer.from(clientData, 'utf8');

      const rpIdHash = createHash('sha256').update(rpId).digest();
      const flags = Buffer.from([0x05]); // UP(0x01) | UV(0x04)
      signCount += 1;
      const counter = Buffer.alloc(4);
      counter.writeUInt32BE(signCount, 0);
      const authData = Buffer.concat([rpIdHash, flags, counter]);

      const signBase = Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]);
      // node の EC 署名は既定で DER (ASN.1)。 WebAuthn の ES256 署名形式と一致する。
      const signature = createSign('sha256').update(signBase).end().sign(privateKey as KeyObject);

      const response: AuthenticationResponseJSON = {
        id: credentialId,
        rawId: credentialId,
        response: {
          clientDataJSON: b64url(clientDataJSON),
          authenticatorData: b64url(authData),
          signature: b64url(signature),
          ...(userHandle ? { userHandle: b64url(Buffer.from(userHandle, 'utf8')) } : {}),
        },
        clientExtensionResults: {},
        type: 'public-key',
        authenticatorAttachment: 'platform',
      };
      return response;
    },
  };
}
