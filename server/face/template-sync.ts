import type Database from 'better-sqlite3';
import { decryptFaceTemplate, deleteFaceTemplate, listFaceTemplates, upsertFaceTemplate } from '../db.ts';

interface ExportedTemplate {
  userId?: unknown;
  template?: unknown;
  modelId?: unknown;
  quality?: unknown;
  version?: unknown;
  enrolledAt?: unknown;
  revoked?: unknown;
}

interface TemplateExportResponse {
  templates?: unknown;
  revoked?: unknown;
}

export interface FaceTemplateSyncOptions {
  db: Database.Database;
  baseUrl: string;
  serviceToken: string;
  facilityId: string;
  key: Buffer;
}

function isTemplate(value: unknown): value is ExportedTemplate {
  return typeof value === 'object' && value !== null;
}

interface ValidTemplate extends ExportedTemplate {
  userId: string;
  template: string;
  modelId: string;
}

function validTemplate(value: ExportedTemplate): value is ValidTemplate {
  return typeof value.userId === 'string' && typeof value.template === 'string' && typeof value.modelId === 'string';
}

/** Cernere の全量 export をローカル AES-GCM キャッシュに反映する。 */
export async function syncFaceTemplates(options: FaceTemplateSyncOptions): Promise<{ ok: boolean; synced: number }> {
  const url = new URL('/api/identity/face-template/export', options.baseUrl);
  url.searchParams.set('facilityId', options.facilityId);
  try {
    const response = await fetch(url, { headers: { authorization: `Bearer ${options.serviceToken}` } });
    if (!response.ok) throw new Error(`face template export failed: HTTP ${response.status}`);
    const body = await response.json() as TemplateExportResponse;
    const templates = Array.isArray(body.templates) ? body.templates.filter(isTemplate) : [];
    const present = new Set<string>();
    let synced = 0;
    const transaction = options.db.transaction(() => {
      for (const item of templates) {
        if (!validTemplate(item) || item.revoked === true) continue;
        const encrypted = Buffer.from(item.template, 'base64');
        const embedding = decryptFaceTemplate(encrypted, options.key);
        present.add(item.userId);
        upsertFaceTemplate(options.db, {
          userId: item.userId,
          template: embedding,
          modelId: item.modelId,
          quality: typeof item.quality === 'number' ? item.quality : 0,
          version: typeof item.version === 'number' ? item.version : 1,
          enrolledAt: typeof item.enrolledAt === 'number' ? item.enrolledAt : Date.now(),
          key: options.key,
        });
        synced += 1;
      }
      const revoked = Array.isArray(body.revoked) ? body.revoked.filter(isTemplate) : [];
      for (const item of revoked) if (typeof item.userId === 'string') deleteFaceTemplate(options.db, item.userId);
      for (const row of listFaceTemplates(options.db)) if (!present.has(row.user_id)) deleteFaceTemplate(options.db, row.user_id);
    });
    transaction();
    return { ok: true, synced };
  } catch {
    return { ok: false, synced: 0 };
  }
}
