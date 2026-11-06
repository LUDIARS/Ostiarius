// 会場ネットワーク限定の新規登録の利用者端末向け API (spec/feature/venue-registration.md §2)。
// 施設 LAN 経路からだけ受ける。
//
//   POST /api/venue-registration/sessions  { nonce }
//     202 { state: "submitted" }       Cernere が attestation を受理した (端末は Cernere の status を見る)
//     400 { error: "bad_request" }     nonce の形式が違う
//     403 { error: "lan_required" }    LAN の外 (中継ヘッダ付き・公開アドレス) からの要求
//     409 { error: "nonce_reused" }    同じ nonce の再送
//     422 { error: <Cernere の拒否コード> }
//     502 { error: <Os 側の送信失敗コード> }
//
// Cernere のログイン画面 (別 origin) から fetch されるので、CORS は Cernere の公開 origin
// (CERNERE_FRONTEND_URL) だけを許可する。受けるのは nonce だけで、本人確認はしない。

import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { allowPrivateNetwork, CERNERE_NONCE_PATTERN } from '../http-security/private-network-access.ts';
import { VENUE_REGISTRATION_ERROR_CODES } from '../venue-registration/cernere-submit.ts';
import { issueVenueRegistration, type VenueRegistrationIssueDeps } from '../venue-registration/issue.ts';

export const VENUE_REGISTRATION_API_PREFIX = '/api/venue-registration/';

export interface VenueRegistrationRouteDeps {
  issue: VenueRegistrationIssueDeps;
  /** 施設 LAN 内からの要求か (face/lan-guard.ts)。 */
  isLan: (c: Context) => boolean;
  /** Cernere のログイン画面の origin。CORS で許可する唯一の origin。 */
  corsOrigin: string;
}

const CERNERE_CODES: ReadonlySet<string> = new Set(VENUE_REGISTRATION_ERROR_CODES);

export function makeVenueRegistrationRouter(deps: VenueRegistrationRouteDeps): Hono {
  const router = new Hono();
  router.use(`${VENUE_REGISTRATION_API_PREFIX}*`, allowPrivateNetwork);
  router.use(`${VENUE_REGISTRATION_API_PREFIX}*`, cors({
    origin: deps.corsOrigin,
    allowMethods: ['POST', 'OPTIONS'],
    allowHeaders: ['content-type'],
  }));

  router.post('/api/venue-registration/sessions', async (c) => {
    c.header('cache-control', 'no-store');
    if (!deps.isLan(c)) return c.json({ error: 'lan_required' }, 403);
    // 端末から受け取るのは nonce だけ。ほかのフィールドが付いていても読まない。
    const body = (await c.req.json().catch(() => null)) as { nonce?: unknown } | null;
    const nonce = body?.nonce;
    if (typeof nonce !== 'string' || !CERNERE_NONCE_PATTERN.test(nonce)) return c.json({ error: 'bad_request' }, 400);
    const result = await issueVenueRegistration(deps.issue, nonce);
    if (result.status === 'accepted') return c.json({ state: 'submitted' }, 202);
    if (result.error === 'nonce_reused') return c.json({ error: result.error }, 409);
    if (CERNERE_CODES.has(result.error)) return c.json({ error: result.error }, 422);
    return c.json({ error: result.error }, 502);
  });
  return router;
}
