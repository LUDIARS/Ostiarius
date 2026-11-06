/** Bounded upload capabilities. Normal one-operation delegation remains separate.
 * @implements SPEC-COMPOSITE-UPLOAD-RESERVATION
 */
import { randomBytes, randomUUID } from "node:crypto";
import { delegationMetadata, type DelegatedHttpOperation, type DelegationTarget, type DelegationDecision } from "./delegation.js";
import { readServiceMetadata, type AuthorityCall, type BoundServiceSession } from "./service-session.js";
import { MAX_CAPTURED_UPLOAD_BYTES, digestCapturedBody, requireUploadLimits, requireUploadOwner, type UploadLimits, type UploadOwner } from "./upload-body.js";

export type UploadHttpOperation = Omit<DelegatedHttpOperation, "body"> & { body: Blob };
export type IncomingUploadOperation = Omit<DelegatedHttpOperation, "body" | "requestId"> & { requestId: string };
export interface UploadCredential { arrivalToken: string; requestId: string; expiresAt: string }
export interface UploadCapture { body: Blob; dispose: () => Promise<void> }
export interface UploadCaptureLimits extends UploadLimits { byteLength: number; expiresAt: string; signal: AbortSignal }
export interface UploadResourceOperation<T> extends UploadOwner {
  risk: "important";
  limits: UploadLimits;
  /** Must bound private memory/disk/concurrency, observe signal and clean up failed capture. */
  capture: (limits: UploadCaptureLimits) => Promise<UploadCapture>;
  authorizeResource: (decision: DelegationDecision) => boolean | Promise<boolean>;
  execute: (body: Blob, decision: DelegationDecision) => T | Promise<T>;
}
const opaque = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
function response(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || ["accessToken", "refreshToken", "projectToken", "sessionToken", "serviceToken"].some(key => key in value)) throw new Error("Invalid upload authority response");
  return value as Record<string, unknown>;
}
function lifetime(value: unknown, maximumSeconds: number): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now()
    || Date.parse(value) > Date.now() + maximumSeconds * 1000) throw new Error("Invalid upload lifetime");
  return value;
}

/** @implements SPEC-COMPOSITE-UPLOAD-RESERVATION */
export class CompositeUploads {
  constructor(private readonly call: AuthorityCall, private readonly projectKey: string) {
    if (!projectKey) throw new Error("Upload project key is required");
  }
  async issue(session: BoundServiceSession, target: DelegationTarget, operation: UploadHttpOperation,
    owner: UploadOwner & { risk: "important" }): Promise<UploadCredential> {
    requireUploadOwner(owner);
    if (owner.risk !== "important" || session.projectKey !== this.projectKey) throw new Error("Current classified upload source is required");
    const capturedBody = operation.body, requestId = operation.requestId ?? randomUUID();
    const metadata = delegationMetadata(operation, requestId);
    const credentials = { projectToken: session.projectToken, sessionBinding: session.sessionBinding,
      targetProject: target.projectKey, targetAudience: target.audience };
    const expiresAt = Date.parse(session.expiresAt);
    const current = { signal: owner.signal, isCurrent: () => Number.isFinite(expiresAt) && Date.now() < expiresAt && owner.isCurrent() };
    const digest = await digestCapturedBody(capturedBody, MAX_CAPTURED_UPLOAD_BYTES, current);
    requireUploadOwner(current);
    const result = response(await this.call("delegate-upload", { ...metadata, ...digest, ...credentials }));
    requireUploadOwner(current);
    if (!opaque(result.arrivalToken) || result.requestId !== requestId) throw new Error("Invalid upload arrival capability");
    const arrivalExpiry = lifetime(result.expiresAt, 30);
    if (Date.parse(arrivalExpiry) > expiresAt) throw new Error("Upload capability exceeds its source session");
    return { arrivalToken: result.arrivalToken, requestId, expiresAt: arrivalExpiry };
  }
  async run<T>(arrivalToken: string, operation: IncomingUploadOperation, resource: UploadResourceOperation<T>): Promise<T> {
    requireUploadOwner(resource);
    if (!opaque(arrivalToken) || resource.risk !== "important" || typeof resource.capture !== "function"
      || typeof resource.authorizeResource !== "function" || typeof resource.execute !== "function") throw new Error("A classified upload and current resource authorization are required");
    const limits = requireUploadLimits(resource.limits), metadata = delegationMetadata(operation, operation.requestId);
    const requestId = metadata.requestId;
    const requestBinding = randomBytes(32).toString("base64url");
    let receipt: string | undefined, captured: UploadCapture | undefined, finalized = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      const started = response(await this.call("begin-upload", { ...metadata, arrivalToken, requestBinding, limits, risk: "important" }));
      if (opaque(started.receipt)) receipt = started.receipt;
      requireUploadOwner(resource);
      const effective = requireUploadLimits(started.limits as UploadLimits);
      const expiresAt = lifetime(started.expiresAt, Math.min(limits.timeoutSeconds, effective.timeoutSeconds));
      if (!receipt || started.requestId !== requestId || started.risk !== "important" || !opaque(started.contentDigest)
        || !Number.isSafeInteger(started.byteLength) || (started.byteLength as number) < 1 || (started.byteLength as number) > effective.maximumBytes
        || effective.maximumBytes > limits.maximumBytes || effective.timeoutSeconds > limits.timeoutSeconds) throw new Error("Invalid upload reservation");
      const deadline = Date.parse(expiresAt);
      timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now())); timer.unref?.();
      const signal = resource.signal ? AbortSignal.any([resource.signal, controller.signal]) : controller.signal;
      const owner = { signal, isCurrent: () => Date.now() < deadline && resource.isCurrent() };
      requireUploadOwner(owner);
      captured = await resource.capture({ ...effective, byteLength: started.byteLength as number, expiresAt, signal });
      requireUploadOwner(owner);
      if (!captured || typeof captured.dispose !== "function") throw new Error("Owned upload capture is required");
      const capturedBody = captured.body;
      const digest = await digestCapturedBody(capturedBody, effective.maximumBytes, owner);
      if (digest.contentDigest !== started.contentDigest || digest.byteLength !== started.byteLength) throw new Error("Upload bytes differ from the reserved body");
      const result = response(await this.call("finalize-upload", { ...metadata, ...digest, receipt, requestBinding, risk: "important" }));
      requireUploadOwner(owner);
      if (result.allowed !== true || result.requestId !== requestId || result.risk !== "important" || result.expiresAt !== expiresAt
        || result.projectKey !== this.projectKey || typeof result.sourceProject !== "string" || !result.sourceProject) throw new Error("Upload was not authorized");
      const decision: DelegationDecision = { ...readServiceMetadata(result), sourceProject: result.sourceProject, requestId, risk: "important" };
      finalized = true;
      if (!await resource.authorizeResource(decision)) throw new Error("Target upload resource access denied");
      requireUploadOwner(owner);
      return await resource.execute(capturedBody, decision);
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
      // Release private bytes before any best-effort remote cancellation I/O.
      try { if (captured && typeof captured.dispose === "function") await captured.dispose(); }
      finally { if (receipt && !finalized) await this.call("cancel-upload", { receipt, requestBinding }).catch(() => {}); }
    }
  }
}
