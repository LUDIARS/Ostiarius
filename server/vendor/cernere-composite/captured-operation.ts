/** Service-owned large bodies use the ordinary permit after capture, without a memory copy.
 * @implements SPEC-COMPOSITE-UPLOAD-RESERVATION
 */
import { randomUUID } from "node:crypto";
import type { AuthorityCall, BoundServiceSession, ServiceOperation, ServiceOperationDecision } from "./service-session.js";
import { digestCapturedBody, requireUploadOwner, type UploadOwner } from "./upload-body.js";

export type CapturedServiceOperation = Omit<ServiceOperation, "body"> & { body: Blob };
export interface CapturedResourceOperation<T> extends UploadOwner {
  risk: "important";
  maximumBytes: number;
  authorizeResource: (decision: ServiceOperationDecision) => boolean | Promise<boolean>;
  execute: (body: Blob, decision: ServiceOperationDecision) => T | Promise<T>;
}
/** @implements SPEC-COMPOSITE-UPLOAD-RESERVATION */
export async function runCapturedServiceOperation<T>(call: AuthorityCall, session: BoundServiceSession,
  operation: CapturedServiceOperation, resource: CapturedResourceOperation<T>): Promise<T> {
  if (resource.risk !== "important" || !operation.action || !operation.resource || typeof resource.authorizeResource !== "function"
    || typeof resource.execute !== "function") throw new Error("Classified captured operation and current resource authorization are required");
  requireUploadOwner(resource);
  const capturedBody = operation.body;
  const fixed = { action: operation.action, resource: operation.resource, requestId: operation.requestId ?? randomUUID(),
    projectToken: session.projectToken, sessionBinding: session.sessionBinding };
  const expiry = Date.parse(session.expiresAt);
  const owner = { signal: resource.signal, isCurrent: () => Number.isFinite(expiry) && Date.now() < expiry && resource.isCurrent() };
  const digest = await digestCapturedBody(capturedBody, resource.maximumBytes, owner);
  const { requestId } = fixed;
  const body = { ...fixed, contentDigest: digest.contentDigest };
  requireUploadOwner(owner);
  const permit = await call("authorize", body) as { permit?: unknown; expiresIn?: unknown; risk?: unknown } | null;
  requireUploadOwner(owner);
  if (!permit || typeof permit.permit !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(permit.permit)
    || permit.expiresIn !== 30 || permit.risk !== "important") throw new Error("Invalid captured operation permit");
  const result = await call("consume", { ...body, permit: permit.permit }) as { allowed?: unknown; requestId?: unknown; risk?: unknown } | null;
  requireUploadOwner(owner);
  if (result?.allowed !== true || result.requestId !== requestId || result.risk !== "important") throw new Error("Captured operation was not authorized");
  const decision = { requestId, risk: "important" as const };
  if (!await resource.authorizeResource(decision)) throw new Error("Service resource access denied");
  requireUploadOwner(owner);
  return resource.execute(capturedBody, decision);
}
