// C-7 resolveTlsConfig(env)
//
// 「TLS を要求した構成が不完全なら HTTP へ落ちずに起動を止める」
// (spec/feature/lan-https-and-lan-url.md) を実行時に観測する。
// 理由文字列に証明書・秘密鍵・ホスト名の値を載せない (欠落した env の key 名だけ)。

import type { OstiariusTlsConfig } from '../server/tls-config.ts';

const PEM_MARKER = '-----BEGIN';

export default {
  pre: (env: NodeJS.ProcessEnv) => (typeof env === 'object' && env !== null) || 'env must be an object',
  post: (config: OstiariusTlsConfig, env: NodeJS.ProcessEnv) => {
    const mode = env.OSTIARIUS_TLS_MODE?.trim() || 'off';
    if (!config.enabled) {
      return mode === 'off' || 'TLS must stay disabled only when the mode is off';
    }
    if (mode !== 'required') return 'TLS must be enabled only for the required mode';
    if (!config.hostname || !config.certificatePem || !config.privateKeyPem) {
      return 'an enabled TLS config must carry hostname, certificate and private key';
    }
    if (/[:/\s]/.test(config.hostname)) return 'hostname must not carry a scheme, port or path';
    return true;
  },
  // 不完全な構成は throw で起動を止める。 例外に鍵・証明書の中身を載せない。
  postThrow: (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return !message.includes(PEM_MARKER) || 'TLS errors must not carry key material';
  },
};
