// 同期タイマーの停止経路 — SIGTERM で listen socket を手放すとき (server/index.ts の
// shutdown) に、 停止途中の同期が走り続けないことを確認する。
// 会場端末は Excubitor が停止 → 再起動するので、 タイマーが残ると次の起動が同じ port を
// 掴み直すまでの間に Cernere を叩き続ける。

import { afterEach, describe, expect, it, vi } from 'vitest';

import { openDb } from '../server/db.ts';
import { startCernereSync } from '../server/cernere-sync.ts';

function exportResponse(): Response {
  return new Response(JSON.stringify({ credentials: [] }), { status: 200 });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Cernere sync lifecycle', () => {
  it('stops the periodic sync through the disposer it returns', async () => {
    vi.useFakeTimers();
    const db = openDb(':memory:');
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(exportResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const stop = startCernereSync({
      db,
      cernereBaseUrl: 'http://cernere.test',
      serviceToken: () => Promise.resolve('service-token'),
      intervalMs: 1_000,
    });

    // 起動時の 1 回 + interval の 1 回。
    await vi.advanceTimersByTimeAsync(1_000);
    const callsWhileRunning = fetchMock.mock.calls.length;
    expect(callsWhileRunning).toBeGreaterThanOrEqual(2);

    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock.mock.calls.length).toBe(callsWhileRunning);

    db.close();
  });
});
