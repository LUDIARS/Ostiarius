// C-9 startCernereSync(opts)
//
// 「SIGTERM で listen socket を手放すときに同期 interval も止められる」
// (server/index.ts の shutdown) を実行時に観測する。 disposer を返さない実装だと
// 停止途中に同期が走り、 Excubitor の再起動が同じ port を掴み直せない。

import type { SyncOptions } from '../server/cernere-sync.ts';

export default {
  pre: (opts: SyncOptions) =>
    (typeof opts?.intervalMs === 'number' && opts.intervalMs > 0) || 'a positive sync interval is required',
  post: (stop: unknown) => typeof stop === 'function' || 'startCernereSync must return a disposer',
};
