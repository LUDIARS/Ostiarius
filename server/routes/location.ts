// GET /api/location — 位置の宣言 (spec/feature/gps-location-statement.md §4)。
//
// GLAB がサーバ側で取得して Aedilis の GPS チェックインへ中継する。
// 位置が未設定の会場は 404 location_not_configured (GPS チェックイン不可)。

import { Hono } from 'hono';

export function makeLocationRouter(issueStatement: () => string | null): Hono {
  const router = new Hono();
  router.get('/api/location', (c) => {
    const locationStatement = issueStatement();
    if (!locationStatement) return c.json({ error: 'location_not_configured' }, 404);
    return c.json({ locationStatement });
  });
  return router;
}
