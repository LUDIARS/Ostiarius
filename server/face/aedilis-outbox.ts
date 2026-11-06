import type Database from 'better-sqlite3';
import { attendanceSender } from '../attendance-delivery.ts';
import { foreignAttestationPurpose } from '../attestation-purpose-guard.ts';
import { acknowledgeOutbox, deferOutbox, enqueueOutbox, listDueOutbox } from '../db.ts';

/** outbox は行き先ごとに `target` で分ける (同意撤回の再送も同じテーブルを使う)。 */
export const ATTESTATION_TARGET = 'aedilis:attest';

export async function deliverAttestation(db: Database.Database, baseUrl: string, token: string, attestation: string): Promise<boolean> {
  // 出席以外の purpose (registration など) は送らず、再送待ちにも積まない。
  if (foreignAttestationPurpose(attestation, 'attendance') !== null) return false;
  const payload = JSON.stringify({ attestation });
  if ((await attendanceSender(baseUrl, token)(attestation)).status === 'recorded') return true;
  enqueueOutbox(db, ATTESTATION_TARGET, payload); return false;
}
export async function retryOutbox(db: Database.Database, baseUrl: string, token: string): Promise<void> {
  for (const row of listDueOutbox(db)) {
    if (row.target !== ATTESTATION_TARGET) continue;
    if (!isAttendancePayload(row.payload)) { acknowledgeOutbox(db, row.id); continue; }
    try { const response = await fetch(`${baseUrl}/api/checkin/gateway-verify`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: row.payload }); if (response.ok) { acknowledgeOutbox(db, row.id); continue; } } catch { /* retry state below preserves the message */ }
    deferOutbox(db, row);
  }
}

/** outbox 行の attestation が出席用か。出席以外 (registration など) は再送せずに捨てる。 */
function isAttendancePayload(payload: string): boolean {
  try {
    const attestation = (JSON.parse(payload) as { attestation?: unknown }).attestation;
    return typeof attestation === 'string' && foreignAttestationPurpose(attestation, 'attendance') === null;
  } catch {
    return false;
  }
}
