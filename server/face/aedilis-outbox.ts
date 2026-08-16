import type Database from 'better-sqlite3';
import { acknowledgeOutbox, deferOutbox, enqueueOutbox, listDueOutbox } from '../db.ts';
export async function deliverAttestation(db: Database.Database, baseUrl: string, token: string, attestation: string): Promise<boolean> {
  const payload = JSON.stringify({ attestation });
  try { const response = await fetch(`${baseUrl}/api/checkin/gateway-verify`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: payload }); if (response.ok) return true; } catch { /* the signed attestation is retained in the local outbox for retry */ }
  enqueueOutbox(db, 'aedilis:attest', payload); return false;
}
export async function retryOutbox(db: Database.Database, baseUrl: string, token: string): Promise<void> {
  for (const row of listDueOutbox(db)) { try { const response = await fetch(`${baseUrl}/api/checkin/gateway-verify`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: row.payload }); if (response.ok) { acknowledgeOutbox(db, row.id); continue; } } catch { /* retry state below preserves the message */ } deferOutbox(db, row); }
}
