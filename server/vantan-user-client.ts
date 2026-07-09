// Cernere プロジェクト WS クライアント — vantan_user プロフィール READ ONLY (SRP)。
//
// Ostiarius は Cernere 上に自分専用の最小プロジェクト ("ostiarius") として登録される
// (Cocoiru の managed-project 定義: `{ project_key: "ostiarius", modules: ["profile"],
// access: "read" }` — E:\Document\Ars\Cocoiru\src\cernere-project-client.ts 参照)。
// 唯一の用途は vantan_user プロジェクトが持つ学生プロフィール (department_name /
// grade / name / desired_job) をモバイルチェックインの確認画面に出すことで、
// 書き込みパスは持たない。
//
// 接続手順・プロトコルは Aedilis の同種クライアントと完全に同一パターン
// (E:\Document\Ars\Aedilis\server\lib\cernere-project-client.ts 参照。 このファイルは
// それを Ostiarius 用に写して read-only ユースケースに絞ったもの):
//   1. POST {CERNERE_BASE_URL}/api/auth/login
//        body: { grant_type: "project_credentials", client_id, client_secret }
//        → 200 { tokenType: "project", accessToken, expiresIn, project: {...} }
//   2. wss://{host}/ws/project へ接続。 認証は Sec-WebSocket-Protocol ヘッダ
//        `bearer, <project JWT>` (?token= query は deprecated なので使わない)。
//   3. プロトコルは module_request/module_response:
//        送信: { type: "module_request", request_id, module, action, payload }
//        成功: { type: "module_response", request_id, module, action, payload }
//        失敗: { type: "error", request_id, code, message }
//
// このモジュールは「未構成 (env 未設定) なら null を返す」ファクトリを公開する
// (createVantanUserClient) — Aedilis はこの機能が必須 (fail-fast) だが、 Ostiarius の
// vantan_user enrichment は「あれば良い」機能なので、 呼び出し側 (index.ts /
// mobile-checkin.ts) はここで null を受け取って enrichment をまるごとスキップできる。
//
// 再接続: 固定 interval retry (Ostiarius の cernere-sync.ts と同じシンプルな方式)。

const DEFAULT_RECONNECT_DELAY_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export interface VantanUserClientConfig {
  /** 末尾スラッシュ有無どちらでも可 (内部で正規化する)。 */
  cernereBaseUrl: string;
  clientId: string;
  clientSecret: string;
  /** テスト注入用。 未指定ならグローバル fetch を使う。 */
  fetchImpl?: typeof fetch;
  /** テスト注入用。 未指定ならグローバル WebSocket (Node 22+ undici 実装) を使う。 */
  createWebSocket?: (url: string, protocols: string[]) => WsLike;
  /** 切断時の固定再接続間隔 (ms)。 default 5000。 */
  reconnectDelayMs?: number;
  /** module_request 応答待ちタイムアウト (ms)。 default 10000。 */
  requestTimeoutMs?: number;
}

/**
 * ブラウザ/undici WebSocket の使用箇所のみを切り出した最小インターフェース。
 * 実体 (new WebSocket(url, protocols)) はこの形を満たすので追加アダプタ不要。
 * テストではこのインターフェースを満たすフェイクを注入する。
 */
export interface WsLike {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

const WS_OPEN = 1;

interface ModuleRequestMessage {
  type: 'module_request';
  request_id: string;
  module: string;
  action: string;
  payload: Record<string, unknown>;
}

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface VantanUserProfile {
  departmentName: string;
  grade: number;
  name: string;
  desiredJob: string | null;
}

const VANTAN_COLUMNS = ['department_name', 'grade', 'name', 'desired_job'] as const;

function defaultCreateWebSocket(url: string, protocols: string[]): WsLike {
  // Node 22+ はグローバル WebSocket (undici 実装) を持つ。 追加パッケージ不要。
  return new WebSocket(url, protocols) as unknown as WsLike;
}

/** cernereBaseUrl (http/https) を /ws/project の ws/wss URL に変換する。 */
function toProjectWsUrl(cernereBaseUrl: string): string {
  const base = cernereBaseUrl.replace(/\/+$/, '');
  return base.replace(/^http/i, 'ws') + '/ws/project';
}

/**
 * Cernere に project として常時接続し、 managed_project.get_user_data (vantan_user
 * 宛) を叩くクライアント。 ライフサイクル管理のみを扱う (業務ロジックは持たない)。
 */
export class VantanUserClient {
  private readonly cernereBaseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly createWs: (url: string, protocols: string[]) => WsLike;
  private readonly reconnectDelayMs: number;
  private readonly requestTimeoutMs: number;

  private ws: WsLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByCaller = false;
  private reqSeq = 0;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(config: VantanUserClientConfig) {
    if (!config.cernereBaseUrl || !config.cernereBaseUrl.trim()) throw new Error('VantanUserClient: cernereBaseUrl is required');
    if (!config.clientId || !config.clientId.trim()) throw new Error('VantanUserClient: clientId is required');
    if (!config.clientSecret || !config.clientSecret.trim()) throw new Error('VantanUserClient: clientSecret is required');
    this.cernereBaseUrl = config.cernereBaseUrl.replace(/\/+$/, '');
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.createWs = config.createWebSocket ?? defaultCreateWebSocket;
    this.reconnectDelayMs = config.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /**
   * 起動時に 1 回呼ぶ。 初回接続を試み、 以後は切断のたびに固定間隔で自動再接続する。
   * 接続失敗は throw せず warn ログのみ (vantan_user enrichment は nice-to-have —
   * Cernere 側未構成/一時不通でも Ostiarius 本体の起動は止めない)。
   */
  start(): void {
    this.closedByCaller = false;
    this.connect().catch((err) => {
      const delay = this.reconnectDelayMs;
      console.warn(`[ostiarius] vantan_user project connect 失敗 (起動時): ${(err as Error).message} — ${delay}ms 後に再試行`);
      this.scheduleReconnect();
    });
  }

  /** 明示的に閉じる (再接続ループも止める)。 テスト/シャットダウン用。 */
  close(): void {
    this.closedByCaller = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('VantanUserClient closed'));
    }
    this.pending.clear();
    if (this.ws) this.ws.close();
    this.ws = null;
  }

  /** 単発の接続試行。 失敗時は throw する (呼び出し側が retry を仕切る)。 */
  async connect(): Promise<void> {
    const token = await this.fetchProjectToken();
    const url = toProjectWsUrl(this.cernereBaseUrl);
    await new Promise<void>((resolve, reject) => {
      const ws = this.createWs(url, ['bearer', token]);
      let settled = false;
      ws.onopen = () => {
        settled = true;
        this.ws = ws;
        console.log('[ostiarius] vantan_user project WS connected');
        resolve();
      };
      ws.onerror = (ev) => {
        if (!settled) {
          settled = true;
          reject(new Error('vantan_user project WS error: ' + describeWsError(ev)));
        }
      };
      ws.onclose = (ev) => {
        this.ws = null;
        const code = ev && typeof ev.code === 'number' ? ev.code : 0;
        if (!settled) {
          settled = true;
          reject(new Error('vantan_user project WS closed before open (code=' + code + ')'));
          return;
        }
        // 開通後の切断 — 保留中リクエストは全て失敗させ、 再接続をスケジュールする。
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error('vantan_user project WS disconnected'));
        }
        this.pending.clear();
        console.warn(`[ostiarius] vantan_user project WS 切断 (code=${code}) — ${this.reconnectDelayMs}ms 後に再接続`);
        this.scheduleReconnect();
      };
      ws.onmessage = (ev) => this.handleMessage(ev.data);
    });
  }

  private scheduleReconnect(): void {
    if (this.closedByCaller || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) => {
        console.warn(`[ostiarius] vantan_user project 再接続失敗: ${(err as Error).message} — ${this.reconnectDelayMs}ms 後に再試行`);
        this.scheduleReconnect();
      });
    }, this.reconnectDelayMs);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  private async fetchProjectToken(): Promise<string> {
    const res = await this.fetchImpl(`${this.cernereBaseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'project_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });
    if (!res.ok) {
      throw new Error(`cernere project login failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { accessToken?: unknown };
    if (typeof body.accessToken !== 'string' || !body.accessToken) {
      throw new Error('cernere project login response missing accessToken');
    }
    return body.accessToken;
  }

  private handleMessage(raw: unknown): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === 'ping') {
      if (this.ws) this.ws.send(JSON.stringify({ type: 'pong', ts: msg.ts }));
      return;
    }
    const requestId = typeof msg.request_id === 'string' ? msg.request_id : undefined;
    if (!requestId) return;
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    if (msg.type === 'module_response') {
      pending.resolve(msg.payload ?? {});
    } else if (msg.type === 'error') {
      pending.reject(new Error(typeof msg.message === 'string' ? msg.message : 'cernere module_request failed'));
    } else {
      pending.reject(new Error('unexpected cernere WS response type: ' + String(msg.type)));
    }
  }

  /** module_request を送って module_response.payload を待つ。 未接続なら即 throw。 */
  private request(moduleName: string, action: string, payload: Record<string, unknown>): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      return Promise.reject(new Error('vantan_user project WS is not connected'));
    }
    const requestId = `ostiarius-${Date.now()}-${this.reqSeq++}`;
    const msg: ModuleRequestMessage = { type: 'module_request', request_id: requestId, module: moduleName, action, payload };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`cernere module_request timed out: ${moduleName}.${action}`));
      }, this.requestTimeoutMs);
      if (timer.unref) timer.unref();
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        if (this.ws) this.ws.send(JSON.stringify(msg));
      } catch (err) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * vantan_user プロジェクトが持つ学生プロフィールを読む。
   *
   * - 接続断/認証失敗/タイムアウトなど「本当に失敗」した場合は throw する。
   * - 対象ユーザーの行が無い、 または全カラムが null (データ未入力) の場合は
   *   throw せず null を返す (呼び出し側は「まだプロフィール未登録」として扱える)。
   */
  async getVantanUserProfile(userId: string): Promise<VantanUserProfile | null> {
    if (!userId || !userId.trim()) throw new Error('getVantanUserProfile: userId is required');
    const raw = await this.request('managed_project', 'get_user_data', {
      userId,
      targetProjectKey: 'vantan_user',
      columns: [...VANTAN_COLUMNS],
    });
    return translateVantanProfile(raw);
  }
}

function describeWsError(ev: unknown): string {
  if (ev && typeof ev === 'object' && 'message' in ev && typeof (ev as { message: unknown }).message === 'string') {
    return (ev as { message: string }).message;
  }
  return 'unknown error';
}

/**
 * snake_case の Cernere カラム名を camelCase の VantanUserProfile へ変換する。
 * 全カラムが null/undefined (行が無い、 または未入力) なら null。
 */
export function translateVantanProfile(raw: unknown): VantanUserProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const allEmpty = VANTAN_COLUMNS.every((c) => r[c] === null || r[c] === undefined);
  if (allEmpty) return null;

  const departmentName = typeof r.department_name === 'string' ? r.department_name : '';
  const name = typeof r.name === 'string' ? r.name : '';
  const desiredJob = typeof r.desired_job === 'string' ? r.desired_job : null;
  const gradeRaw = r.grade;
  let grade = 0;
  if (typeof gradeRaw === 'number') {
    grade = gradeRaw;
  } else if (typeof gradeRaw === 'string' && gradeRaw.trim() !== '' && Number.isFinite(Number(gradeRaw))) {
    grade = Number(gradeRaw);
  }

  return { departmentName, grade, name, desiredJob };
}

/**
 * index.ts から呼ぶファクトリ。 env 解決済みの config を渡す (このファイルは env を知らない)。
 * clientId/clientSecret が未設定 (空文字) なら接続せず null を返す — 呼び出し側は
 * これを「vantan_user enrichment 機能オフ」として扱い、 起動を止めずに続行できる。
 */
export function createVantanUserClient(config: VantanUserClientConfig): VantanUserClient | null {
  if (!config.clientId || !config.clientId.trim() || !config.clientSecret || !config.clientSecret.trim()) {
    return null;
  }
  return new VantanUserClient(config);
}
