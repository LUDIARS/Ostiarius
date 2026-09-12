// C-1 loadLocalFaceKeys(dataDir)
//
// 「鍵は kiosk ホスト内で生成し、ホスト外へ出さない」(spec/plan/face-data-local-only.md §3)
// を実行時に観測する。理由文字列に鍵・パスを載せない。

import type { LocalFaceKeys } from '../server/face/local-key.ts';

const KEY_BYTES = 32;

export default {
  pre: (dataDir: string) => (typeof dataDir === 'string' && dataDir.length > 0) || 'data directory is required',
  post: (keys: LocalFaceKeys) => {
    if (keys.template.key.length !== KEY_BYTES) return 'template key must be 32 bytes';
    if (keys.photo.key.length !== KEY_BYTES) return 'photo key must be 32 bytes';
    if (!keys.template.keyId || !keys.photo.keyId) return 'each key must carry a key id';
    if (keys.template.keyId === keys.photo.keyId) return 'template and photo keys must be separate';
    return true;
  },
};
