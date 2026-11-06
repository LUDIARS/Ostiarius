import { createHash, randomUUID } from "node:crypto";
import { isServiceOperationRisk, readServiceMetadata, type AuthorityCall, type BoundServiceSession, type ServiceOperation, type ServiceOperationRisk } from "./service-session.js";

export interface DelegatedHttpOperation extends ServiceOperation {
  method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Exact canonical pathname + query sent to the destination. resource must equal path. */
  path: string;
  /** Actual outgoing/incoming headers, after body serialization. */
  headers: Headers;
  /** Additional route-owned header names that influence authorization or semantics. */
  additionalHeaders?: readonly string[];
}
export interface DelegationTarget { projectKey: string; audience: string }
export interface DelegationCredential { delegationToken: string; requestId: string; expiresAt: string }
export interface DelegationDecision extends Pick<BoundServiceSession, "user" | "projectKey" | "expiresAt"> { sourceProject: string; requestId: string; risk: ServiceOperationRisk }
export interface DelegatedResourceOperation<T> {
  risk: ServiceOperationRisk;
  authorizeResource: (decision: DelegationDecision) => boolean | Promise<boolean>;
  execute: (decision: DelegationDecision) => T | Promise<T>;
}
const STANDARD_HEADERS = ["accept", "accept-language", "content-type", "content-encoding", "content-language", "if-match", "if-none-match", "range", "idempotency-key"];
/** Canonical digest of semantic headers, never an authentication credential.
 * Both endpoints use the destination's route-owned additional list.
 * @implements SPEC-COMPOSITE-DELEGATION
 */
export function delegationHeadersDigest(headers: Headers, additional: readonly string[] = []): string {
  if (additional.length > 32) throw new Error("Too many delegated semantic headers");
  const checked = new Headers();
  for (const name of additional) checked.set(name, "");
  const names = [...new Set([...STANDARD_HEADERS, ...checked.keys()])].sort();
  if (names.some(name => ["authorization", "proxy-authorization", "cookie", "set-cookie"].includes(name) || name.startsWith("x-cernere-"))) {
    throw new Error("Authentication headers cannot be semantic delegation headers");
  }
  return createHash("sha256").update(JSON.stringify(names.map(name => [name, headers.get(name)])), "utf8").digest("base64url");
}
/** @implements SPEC-COMPOSITE-DELEGATION SPEC-COMPOSITE-UPLOAD-RESERVATION */
export function delegationMetadata(operation: Omit<DelegatedHttpOperation, "body">, requestId: string) {
  if (!operation.action || !operation.path || operation.resource !== operation.path) throw new Error("A classified canonical delegated HTTP resource is required");
  const parsed = new URL(operation.path, "https://delegation.invalid");
  if (parsed.origin !== "https://delegation.invalid" || parsed.pathname + parsed.search !== operation.path || parsed.hash) throw new Error("Invalid delegated request path");
  return { action: operation.action, method: operation.method, path: operation.path, resource: operation.resource, requestId,
    headersDigest: delegationHeadersDigest(operation.headers, operation.additionalHeaders) };
}
function envelope(operation: DelegatedHttpOperation, requestId: string) {
  return { ...delegationMetadata(operation, requestId), contentDigest: createHash("sha256").update(operation.body).digest("base64url") };
}
function lifetime(expiresAt: unknown): string {
  if (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()
    || Date.parse(expiresAt) > Date.now() + 30_000) throw new Error("Invalid delegation lifetime");
  return expiresAt;
}
function authorityResponse(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || ["accessToken", "refreshToken", "projectToken", "serviceToken", "sessionToken"].some(key => key in value)) {
    throw new Error("Invalid delegation authority response");
  }
  return value as Record<string, unknown>;
}

/** Online, one-operation capabilities; neither user tokens nor reusable service sessions.
 * @implements SPEC-COMPOSITE-DELEGATION
 */
export class CompositeDelegations {
  constructor(private readonly call: AuthorityCall, private readonly projectKey: string) {
    if (!projectKey) throw new Error("Delegation project key is required");
  }
  async issue(session: BoundServiceSession, target: DelegationTarget, operation: DelegatedHttpOperation): Promise<DelegationCredential> {
    if (session.projectKey !== this.projectKey || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now()) {
      throw new Error("Current source service session is required");
    }
    const requestId = operation.requestId ?? randomUUID();
    const response = authorityResponse(await this.call("delegate", { ...envelope(operation, requestId), projectToken: session.projectToken,
      sessionBinding: session.sessionBinding, targetProject: target.projectKey, targetAudience: target.audience }));
    if (typeof response.delegationToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(response.delegationToken)
      || response.requestId !== requestId) throw new Error("Invalid delegation credential");
    const expiresAt = lifetime(response.expiresAt);
    if (Date.parse(expiresAt) > Date.parse(session.expiresAt)) throw new Error("Delegation outlives its source session");
    return { delegationToken: response.delegationToken, requestId, expiresAt };
  }
  async run<T>(token: string, operation: DelegatedHttpOperation & { requestId: string }, resource: DelegatedResourceOperation<T>): Promise<T> {
    if (typeof resource.authorizeResource !== "function" || typeof resource.execute !== "function") throw new Error("Current destination resource authorization is required");
    if (!isServiceOperationRisk(resource.risk)) throw new Error("Destination operation risk is not classified");
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("Invalid delegation capability");
    const value = authorityResponse(await this.call("consume-delegation", { delegationToken: token, ...envelope(operation, operation.requestId) }));
    const metadata = readServiceMetadata(value);
    if (value.allowed !== true || value.requestId !== operation.requestId || metadata.projectKey !== this.projectKey
      || typeof value.sourceProject !== "string" || !value.sourceProject || value.sourceProject === this.projectKey || !isServiceOperationRisk(value.risk)
      || value.risk !== resource.risk) throw new Error("Delegation destination or risk does not match");
    const decision: DelegationDecision = { ...metadata, sourceProject: value.sourceProject, requestId: operation.requestId, risk: value.risk, expiresAt: lifetime(metadata.expiresAt) };
    if (!await resource.authorizeResource(decision)) throw new Error("Destination resource access denied");
    return resource.execute(decision);
  }
}
