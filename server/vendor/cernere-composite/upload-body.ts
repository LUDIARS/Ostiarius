/** Incremental standard digest of owned captured bytes; never accepts a supplied digest.
 * @implements SPEC-COMPOSITE-UPLOAD-RESERVATION
 */
import { createHash } from "node:crypto";

export interface UploadOwner { isCurrent: () => boolean; signal?: AbortSignal }
export interface UploadLimits { maximumBytes: number; timeoutSeconds: number }
/** Protocol ceiling; hosts must independently declare their stricter route/quota. */
export const MAX_CAPTURED_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
/** @implements SPEC-COMPOSITE-UPLOAD-RESERVATION */
export function requireUploadLimits(value: UploadLimits): UploadLimits {
  if (!value || !Number.isSafeInteger(value.maximumBytes) || value.maximumBytes < 1 || value.maximumBytes > MAX_CAPTURED_UPLOAD_BYTES
    || !Number.isSafeInteger(value.timeoutSeconds) || value.timeoutSeconds < 1 || value.timeoutSeconds > 300) throw new Error("Invalid route-owned upload limits");
  return { maximumBytes: value.maximumBytes, timeoutSeconds: value.timeoutSeconds };
}
/** @implements SPEC-COMPOSITE-UPLOAD-RESERVATION */
export function requireUploadOwner(owner: UploadOwner): void {
  if (typeof owner?.isCurrent !== "function" || !owner.isCurrent() || owner.signal?.aborted) throw new Error("Upload owner ended");
}
/** @implements SPEC-COMPOSITE-UPLOAD-RESERVATION */
export async function digestCapturedBody(body: Blob, maximumBytes: number, owner: UploadOwner): Promise<{ contentDigest: string; byteLength: number }> {
  requireUploadOwner(owner);
  if (!(body instanceof Blob) || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_CAPTURED_UPLOAD_BYTES
    || body.size < 1 || body.size > maximumBytes) throw new Error("Invalid captured upload body");
  const reader = body.stream().getReader(), hash = createHash("sha256");
  let ended = false, length = 0;
  const cancel = (): void => { void reader.cancel().catch(() => {}); };
  owner.signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      requireUploadOwner(owner);
      const part = await reader.read();
      requireUploadOwner(owner);
      if (part.done) { ended = true; break; }
      length += part.value.byteLength;
      if (length > maximumBytes || length > body.size) throw new Error("Captured upload exceeds its fixed size");
      hash.update(part.value);
    }
    if (length !== body.size) throw new Error("Captured upload size changed");
    return { contentDigest: hash.digest("base64url"), byteLength: length };
  } finally {
    owner.signal?.removeEventListener("abort", cancel);
    if (!ended) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
