import type Database from 'better-sqlite3';
import { acknowledgeOutbox, deferOutbox, enqueueOutbox, listDueOutbox } from '../db.ts';

/** outbox は行き先ごとに `target` で分ける (同意撤回の再送も同じテーブルを使う)。 */
export const ATTESTATION_TARGET = 'aedilis:attest';

export async function deliverAttestation(db: Database.Database, baseUrl: string, token: string, attestation: string): Promise<boolean> {
  const payload = JSON.stringify({ attestation });
  try { const response = await fetch(`${baseUrl}/api/checkin/gateway-verify`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: payload }); if (response.ok) return true; } catch { /* the signed attestation is retained in the local outbox for retry */ }
  enqueueOutbox(db, ATTESTATION_TARGET, payload); return false;
}
export async function retryOutbox(db: Database.Database, baseUrl: string, token: string): Promise<void> {
  for (const row of listDueOutbox(db)) {
    if (row.target !== ATTESTATION_TARGET) continue;
    try { const response = await fetch(`${baseUrl}/api/checkin/gateway-verify`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: row.payload }); if (response.ok) { acknowledgeOutbox(db, row.id); continue; } } catch { /* retry state below preserves the message */ }
    deferOutbox(db, row);
  }
}
