// VantanUserClient / createVantanUserClient のユニットテスト。
//
// Aedilis (E:\Document\Ars\Aedilis\test\cernere-project-client.test.ts) と同じ
// テストパターン: 実 WS / 実 Cernere には繋がず、 WsLike を満たすフェイクソケット +
// fetch モックを注入して module_request/module_response のやり取りを検証する。
// 加えて Ostiarius 固有の関心事 (createVantanUserClient が未構成時に null を返す
// = 呼び出し側が enrichment を丸ごとスキップできる) を検証する。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VantanUserClient,
  createVantanUserClient,
  translateVantanProfile,
  type WsLike,
} from '../server/vantan-user-client.ts';

/** WsLike を満たす手動制御可能なフェイクソケット。 */
class FakeWebSocket implements WsLike {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  readyState = 0; // CONNECTING
  readonly sent: string[] = [];

  constructor(public readonly url: string, public readonly protocols: string[]) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3; // CLOSED
    this.onclose?.({ code: code ?? 1000, reason: reason ?? '' });
  }

  simulateOpen(): void {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }

  simulateMessage(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }

  simulateServerClose(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: 'server closed' });
  }
}

function makeFetchOk(accessToken = 'proj-token-abc'): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ tokenType: 'project', accessToken, expiresIn: 3600 }),
  })) as unknown as typeof fetch;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createVantanUserClient — factory (未構成時は null を返す)', () => {
  it('returns null when clientId is empty (env unset)', () => {
    const client = createVantanUserClient({
      cernereBaseUrl: 'https://cernere.example.com',
      clientId: '',
      clientSecret: 'secret',
    });
    expect(client).toBeNull();
  });

  it('returns null when clientSecret is empty (env unset)', () => {
    const client = createVantanUserClient({
      cernereBaseUrl: 'https://cernere.example.com',
      clientId: 'ostiarius',
      clientSecret: '',
    });
    expect(client).toBeNull();
  });

  it('returns null when both are whitespace-only', () => {
    const client = createVantanUserClient({
      cernereBaseUrl: 'https://cernere.example.com',
      clientId: '   ',
      clientSecret: '   ',
    });
    expect(client).toBeNull();
  });

  it('returns a working VantanUserClient instance when both are configured', () => {
    const client = createVantanUserClient({
      cernereBaseUrl: 'https://cernere.example.com',
      clientId: 'ostiarius',
      clientSecret: 'secret',
    });
    expect(client).toBeInstanceOf(VantanUserClient);
  });
});

describe('translateVantanProfile', () => {
  it('translates a full snake_case row to camelCase', () => {
    const result = translateVantanProfile({
      department_name: 'ゲーム学部',
      grade: 2,
      name: '山田太郎',
      desired_job: 'ゲームプログラマー',
    });
    expect(result).toEqual({
      departmentName: 'ゲーム学部',
      grade: 2,
      name: '山田太郎',
      desiredJob: 'ゲームプログラマー',
    });
  });

  it('returns null when every requested column is null', () => {
    expect(
      translateVantanProfile({ department_name: null, grade: null, name: null, desired_job: null }),
    ).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(translateVantanProfile(null)).toBeNull();
    expect(translateVantanProfile(undefined)).toBeNull();
  });
});

describe('VantanUserClient — construction', () => {
  it('throws fail-fast when cernereBaseUrl is missing', () => {
    expect(() => new VantanUserClient({ cernereBaseUrl: '', clientId: 'a', clientSecret: 'b' })).toThrow(
      /cernereBaseUrl/,
    );
  });

  it('throws fail-fast when clientId is missing', () => {
    expect(() => new VantanUserClient({ cernereBaseUrl: 'https://x', clientId: '', clientSecret: 'b' })).toThrow(
      /clientId/,
    );
  });
});

describe('VantanUserClient — getVantanUserProfile() (configured, connected)', () => {
  let sockets: FakeWebSocket[];
  let client: VantanUserClient;
  let ws: FakeWebSocket;

  async function buildConnectedClient(): Promise<void> {
    sockets = [];
    const createWebSocket = (url: string, protocols: string[]) => {
      const s = new FakeWebSocket(url, protocols);
      sockets.push(s);
      return s;
    };
    const created = createVantanUserClient({
      cernereBaseUrl: 'https://cernere.example.com',
      clientId: 'ostiarius',
      clientSecret: 's3cret',
      fetchImpl: makeFetchOk(),
      createWebSocket,
      requestTimeoutMs: 200,
    });
    if (!created) throw new Error('expected a configured client');
    client = created;
    const connectPromise = client.connect();
    await flush();
    ws = sockets[0]!;
    ws.simulateOpen();
    await connectPromise;
  }

  beforeEach(async () => {
    await buildConnectedClient();
  });

  afterEach(() => {
    client.close();
  });

  it('sends userId + targetProjectKey=vantan_user + requested columns, and translates the response', async () => {
    const promise = client.getVantanUserProfile('user-42');
    await flush();
    expect(ws.sent).toHaveLength(1);
    const sentMsg = JSON.parse(ws.sent[0]!);
    expect(sentMsg).toMatchObject({
      type: 'module_request',
      module: 'managed_project',
      action: 'get_user_data',
      payload: {
        userId: 'user-42',
        targetProjectKey: 'vantan_user',
        columns: ['department_name', 'grade', 'name', 'desired_job'],
      },
    });

    ws.simulateMessage({
      type: 'module_response',
      request_id: sentMsg.request_id,
      payload: {
        department_name: 'ゲーム学部',
        grade: 3,
        name: '山田太郎',
        desired_job: 'ゲームプランナー',
      },
    });

    await expect(promise).resolves.toEqual({
      departmentName: 'ゲーム学部',
      grade: 3,
      name: '山田太郎',
      desiredJob: 'ゲームプランナー',
    });
  });

  it('resolves null (no row / all columns null) without throwing', async () => {
    const promise = client.getVantanUserProfile('user-no-data');
    await flush();
    const sentMsg = JSON.parse(ws.sent[0]!);
    ws.simulateMessage({
      type: 'module_response',
      request_id: sentMsg.request_id,
      payload: { department_name: null, grade: null, name: null, desired_job: null },
    });
    await expect(promise).resolves.toBeNull();
  });

  it('throws when Cernere returns a module error', async () => {
    const promise = client.getVantanUserProfile('user-42');
    await flush();
    const sentMsg = JSON.parse(ws.sent[0]!);
    ws.simulateMessage({
      type: 'error',
      request_id: sentMsg.request_id,
      code: 'command_error',
      message: 'project not authorized for cross-project read',
    });
    await expect(promise).rejects.toThrow(/not authorized/);
  });

  it('throws on request timeout when no response ever arrives', async () => {
    const promise = client.getVantanUserProfile('user-slow');
    await expect(promise).rejects.toThrow(/timed out/);
  }, 2000);
});

describe('VantanUserClient — not connected', () => {
  it('throws (does not hang) when getVantanUserProfile is called before any connection', async () => {
    const client = new VantanUserClient({
      cernereBaseUrl: 'https://cernere.example.com',
      clientId: 'ostiarius',
      clientSecret: 's3cret',
      fetchImpl: makeFetchOk(),
      createWebSocket: (url, protocols) => new FakeWebSocket(url, protocols),
    });
    await expect(client.getVantanUserProfile('user-1')).rejects.toThrow(/not connected/);
  });
});

describe('VantanUserClient — reconnect', () => {
  it('automatically reconnects after an unexpected disconnect', async () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeWebSocket[] = [];
      const createWebSocket = (url: string, protocols: string[]) => {
        const s = new FakeWebSocket(url, protocols);
        sockets.push(s);
        return s;
      };
      const client = new VantanUserClient({
        cernereBaseUrl: 'https://cernere.example.com',
        clientId: 'ostiarius',
        clientSecret: 's3cret',
        fetchImpl: makeFetchOk(),
        createWebSocket,
        reconnectDelayMs: 1000,
      });

      client.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets).toHaveLength(1);
      sockets[0]!.simulateOpen();
      await vi.advanceTimersByTimeAsync(0);

      sockets[0]!.simulateServerClose();
      await vi.advanceTimersByTimeAsync(1000);
      expect(sockets).toHaveLength(2);

      client.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
