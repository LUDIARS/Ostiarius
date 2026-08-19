// Cernere の service Bearer (passkey export / 顔テンプレート取得に使う) の供給。
//
// Cernere が発行する project token の TTL は 60 分 (Cernere `server/src/auth/jwt.ts` の
// SERVICE_TOKEN_MINUTES)。 静的な値を Infisical に置くと 1 時間で失効し、 同期は
// best-effort で warn しか出さないため「health は緑のまま公開鍵が古い」状態になる。
// そこで Excubitor が起動ごとに注入する project client credential
// (CERNERE_PROJECT_CLIENT_ID / CERNERE_PROJECT_CLIENT_SECRET) から token を取り、
// 期限が来る前に取り直す。
//
// 取得手順は vantan-user-client.ts と同じ:
//   POST {CERNERE_BASE_URL}/api/auth/login
//     { grant_type: "project_credentials", client_id, client_secret }
//   → 200 { tokenType: "project", accessToken, expiresIn }

/** 呼ぶたびに「いま有効な」 Bearer を返す。 期限管理は実装側の責務。 */
export type ServiceTokenProvider = () => Promise<string>;

/** 期限ぎりぎりの token を配らないための猶予。 通信と検証の往復ぶんを見込む。 */
const EXPIRY_SKEW_MS = 60_000;
/** expiresIn が欠けている応答を無期限扱いしないための下限。 */
const FALLBACK_TTL_MS = 5 * 60_000;

export interface ServiceTokenOptions {
  cernereBaseUrl: string;
  clientId: string;
  clientSecret: string;
  /** テスト注入用。 未指定ならグローバル fetch。 */
  fetchImpl?: typeof fetch;
  /** テスト注入用。 未指定なら Date.now。 */
  now?: () => number;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * project client credential から service token を取り、 期限まで使い回す provider を作る。
 *
 * 同時に複数の呼び出しが来ても login は 1 回で済ませる (in-flight を共有する)。
 * Cernere は `project_login:<client_id>` に 10 回 / 5 分のレートリミットを持つため、
 * 取得を重ねると同期そのものが止まる。
 */
export function createServiceTokenProvider(options: ServiceTokenOptions): ServiceTokenProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const baseUrl = options.cernereBaseUrl.replace(/\/+$/, '');
  let cached: CachedToken | null = null;
  let inFlight: Promise<CachedToken> | null = null;

  async function login(): Promise<CachedToken> {
    const response = await fetchImpl(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      // The request body contains the client secret. Never follow a redirect
      // that could forward it to an unintended origin.
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'project_credentials',
        client_id: options.clientId,
        client_secret: options.clientSecret,
      }),
    });
    if (!response.ok) {
      throw new Error(`cernere project login failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { accessToken?: unknown; expiresIn?: unknown };
    if (typeof body.accessToken !== 'string' || !body.accessToken) {
      throw new Error('cernere project login returned no accessToken');
    }
    const ttlSec = typeof body.expiresIn === 'number' && Number.isFinite(body.expiresIn) && body.expiresIn > 0
      ? body.expiresIn * 1_000
      : FALLBACK_TTL_MS;
    return { token: body.accessToken, expiresAt: now() + Math.max(ttlSec - EXPIRY_SKEW_MS, 0) };
  }

  return async () => {
    if (cached && cached.expiresAt > now()) return cached.token;
    if (!inFlight) {
      inFlight = login().finally(() => { inFlight = null; });
    }
    cached = await inFlight;
    return cached.token;
  };
}

/** 手で発行した固定 token を使う経路 (運用者の一時確認用)。 期限管理はしない。 */
export function staticServiceTokenProvider(token: string): ServiceTokenProvider {
  return () => Promise.resolve(token);
}
