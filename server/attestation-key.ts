// ゲートウェイの attestation 署名鍵 (Ed25519) の永続化。
//
// CONTRACTS.md §3: 鍵は `OSTIARIUS_KEY_PATH` に永続。 無ければ生成して保存し、
// 公開鍵 PEM を起動ログに出す (運用者が Aedilis の POST /api/admin/gateways に登録)。
//
// secret 平文保存は本来 NG ([[feedback_config_and_secrets]]) だが、 スパイク段階は
// ファイル権限 (0600) で保護した平文 PKCS#8 PEM を許す (README に注記)。

import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export interface GatewayKeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicKeyPem: string; // SPKI PEM — Aedilis が gateway_registry に登録する値
}

/**
 * keyPath の Ed25519 秘密鍵 (PKCS#8 PEM) を読み込む。 無ければ生成して保存する。
 * 公開鍵は秘密鍵から導出するので別ファイルは持たない。
 */
export function loadOrCreateKeyPair(keyPath: string): GatewayKeyPair {
  let privateKey: KeyObject;

  if (existsSync(keyPath)) {
    const pem = readFileSync(keyPath, 'utf8');
    privateKey = createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error(
        `[ostiarius] ${keyPath} は ed25519 鍵ではありません (${privateKey.asymmetricKeyType})`,
      );
    }
  } else {
    const pair = generateKeyPairSync('ed25519');
    privateKey = pair.privateKey;
    const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    mkdirSync(dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, pkcs8, { mode: 0o600 });
    try {
      chmodSync(keyPath, 0o600); // Windows では no-op に近いが best-effort
    } catch {
      /* ignore */
    }
    console.log(`[ostiarius] 新規 Ed25519 鍵を生成して保存: ${keyPath}`);
  }

  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { privateKey, publicKey, publicKeyPem };
}
