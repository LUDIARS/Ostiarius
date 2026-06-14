// Cernere passkey 公開鍵の同期。
//
// CONTRACTS.md §2 / §3:
//   起動時 + 定期 (default 15min) に
//     GET {CERNERE_BASE_URL}/api/auth/passkey/export  (Bearer CERNERE_SERVICE_TOKEN)
//   → credentials テーブルへ upsert。
//   ネット不通時は前回キャッシュで継続 (warn ログのみ、 hard fail しない)。
//
// オフライン検証 (= 家からは LAN に届かない) を成立させるための土台。

import type Database from 'better-sqlite3';
import { countCredentials, upsertCredential } from './db.ts';

interface ExportedCredential {
  userId: string;
  credentialId: string; // base64url
  publicKey: string; // base64 COSE
  counter?: number;
  transports?: string[];
}

interface ExportResponse {
  credentials?: ExportedCredential[];
}

export interface SyncOptions {
  db: Database.Database;
  cernereBaseUrl: string;
  serviceToken: string;
  intervalMs: number;
}

let timer: NodeJS.Timeout | null = null;

/** 起動時に 1 回同期 → interval で繰り返す。 timer は unref して終了をブロックしない。 */
export function startCernereSync(opts: SyncOptions): void {
  void syncOnce(opts);
  if (timer) clearInterval(timer);
  timer = setInterval(() => void syncOnce(opts), opts.intervalMs);
  timer.unref?.();
}

/** 1 回分の同期。 例外は握りつぶし warn — 前回キャッシュで運用継続できるようにする。 */
export async function syncOnce(opts: SyncOptions): Promise<{ ok: boolean; synced: number }> {
  const url = `${opts.cernereBaseUrl}/api/auth/passkey/export`;
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${opts.serviceToken}` },
    });
    if (!res.ok) {
      throw new Error(`export failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as ExportResponse;
    const list = Array.isArray(body?.credentials) ? body.credentials : [];

    let synced = 0;
    const tx = opts.db.transaction((rows: ExportedCredential[]) => {
      for (const r of rows) {
        if (!r?.userId || !r?.credentialId || !r?.publicKey) continue;
        upsertCredential(opts.db, {
          userId: r.userId,
          credentialId: r.credentialId,
          publicKey: r.publicKey,
          counter: typeof r.counter === 'number' ? r.counter : 0,
          transports: Array.isArray(r.transports) ? r.transports : [],
        });
        synced++;
      }
    });
    tx(list);

    console.log(`[ostiarius] passkey sync ok: upserted ${synced} (cache total=${countCredentials(opts.db)})`);
    return { ok: true, synced };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      `[ostiarius] passkey sync 失敗: ${msg} — 前回キャッシュで継続 (cache total=${countCredentials(opts.db)})`,
    );
    return { ok: false, synced: 0 };
  }
}
