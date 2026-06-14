// ゲートウェイの attestation 署名鍵 (Ed25519) の永続化。
//
// CONTRACTS.md §3: 公開鍵 PEM を起動ログに出す (運用者 or 自己登録で Aedilis の
// POST /api/admin/gateways に登録)。
//
// 秘密鍵の供給は 2 経路 ([[feedback_config_and_secrets]]):
//   1. 本番: `OSTIARIUS_PRIVATE_KEY` env (Infisical / secret-agent が PKCS#8 PEM を
//      inject)。 平文ファイルを置かない。 env があればこちらを最優先で使う。
//   2. dev: `OSTIARIUS_KEY_PATH` の平文 PKCS#8 PEM ファイル (無ければ生成して保存、
//      0600 best-effort)。 env が無いときのフォールバック。

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
  /** 秘密鍵の供給元 — ログ/運用判断用 */
  source: 'env' | 'file' | 'generated';
}

export interface KeySourceOptions {
  /** OSTIARIUS_PRIVATE_KEY — env inject された PKCS#8 PEM (本番、 最優先) */
  privateKeyPem?: string;
  /** OSTIARIUS_KEY_PATH — dev 用の平文 PEM ファイルパス */
  keyPath: string;
}

function assertEd25519(privateKey: KeyObject, origin: string): void {
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `[ostiarius] ${origin} は ed25519 鍵ではありません (${privateKey.asymmetricKeyType})`,
    );
  }
}

function deriveKeyPair(privateKey: KeyObject, source: GatewayKeyPair['source']): GatewayKeyPair {
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { privateKey, publicKey, publicKeyPem, source };
}

/**
 * Ed25519 秘密鍵を解決する。
 *
 *  - env (`privateKeyPem`) があればそれを使う (本番 = Infisical inject、 ファイル不要)。
 *  - 無ければ keyPath の平文 PEM を読む。 ファイルが無ければ生成して保存する (dev)。
 *
 * 公開鍵は秘密鍵から導出するので別ファイルは持たない。
 */
export function loadOrCreateKeyPair(opts: KeySourceOptions): GatewayKeyPair {
  const envPem = opts.privateKeyPem?.trim();
  if (envPem) {
    const privateKey = createPrivateKey(envPem);
    assertEd25519(privateKey, 'OSTIARIUS_PRIVATE_KEY');
    return deriveKeyPair(privateKey, 'env');
  }

  const { keyPath } = opts;
  if (existsSync(keyPath)) {
    const pem = readFileSync(keyPath, 'utf8');
    const privateKey = createPrivateKey(pem);
    assertEd25519(privateKey, keyPath);
    return deriveKeyPair(privateKey, 'file');
  }

  const pair = generateKeyPairSync('ed25519');
  const privateKey = pair.privateKey;
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  mkdirSync(dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, pkcs8, { mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600); // Windows では no-op に近いが best-effort
  } catch {
    /* ignore */
  }
  console.log(`[ostiarius] 新規 Ed25519 鍵を生成して保存: ${keyPath}`);
  return deriveKeyPair(privateKey, 'generated');
}
