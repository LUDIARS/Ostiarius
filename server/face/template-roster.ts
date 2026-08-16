import type Database from 'better-sqlite3';
import { decryptFaceTemplate, listFaceTemplates } from '../db.ts';
import type { FaceRoster } from './matcher.ts';
export function buildFaceRoster(db: Database.Database, key: Buffer, modelId: string): FaceRoster {
  const userIds: string[] = []; const embeddings: Float32Array[] = [];
  for (const row of listFaceTemplates(db)) { if (row.model_id !== modelId) continue; try { userIds.push(row.user_id); embeddings.push(decryptFaceTemplate(row.template_enc, key)); } catch { /* corrupted encrypted cache rows are excluded without exposing biometric material */ } }
  return { userIds, embeddings };
}
