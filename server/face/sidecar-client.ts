export interface SidecarFace { quality: { pass: boolean; fail: string[] }; liveness?: number; embedding?: string; blendshapes?: Record<string, number>; pose?: { yaw: number; pitch: number }; }
export interface FaceSidecar { health(): Promise<{ ok: boolean; modelId: string }>; analyze(frame: Uint8Array, want: readonly string[]): Promise<SidecarFace[]>; embedBatch(frames: readonly string[]): Promise<{ embeddings: Array<string | null>; qualities: Array<{ pass: boolean }> }>; }
function decodeEmbedding(value: string): Float32Array | null { const bytes = Buffer.from(value, 'base64'); return bytes.byteLength === 2048 ? new Float32Array(bytes.buffer, bytes.byteOffset, 512).slice() : null; }
export function decodeFaceEmbedding(value: string | undefined): Float32Array | null { return value ? decodeEmbedding(value) : null; }
export function createSidecarClient(baseUrl: string): FaceSidecar {
  return {
    async health() { const response = await fetch(`${baseUrl}/v1/health`); if (!response.ok) return { ok: false, modelId: '' }; const body = await response.json() as { ok?: unknown; modelId?: unknown }; return { ok: body.ok === true, modelId: typeof body.modelId === 'string' ? body.modelId : '' }; },
    async analyze(frame, want) { const form = new FormData(); const copy = Uint8Array.from(frame); form.set('image', new Blob([copy]), 'frame.jpg'); form.set('want', want.join(',')); const response = await fetch(`${baseUrl}/v1/analyze`, { method: 'POST', body: form }); if (!response.ok) throw new Error(`sidecar HTTP ${response.status}`); const body = await response.json() as { faces?: SidecarFace[] }; return Array.isArray(body.faces) ? body.faces : []; },
    async embedBatch(frames) { const response = await fetch(`${baseUrl}/v1/embed-batch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ images: frames }) }); if (!response.ok) throw new Error(`sidecar HTTP ${response.status}`); return await response.json() as { embeddings: Array<string | null>; qualities: Array<{ pass: boolean }> }; },
  };
}
