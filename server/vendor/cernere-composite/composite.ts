import type { CompositeConfig, ExchangeResult } from "./types.js";
import { CompositeServiceSessions, CompositeAuthorityError } from "./service-session.js";
import { CompositeDelegations } from "./delegation.js";
import { CompositeServiceIdentity } from "./service-identity.js";
import { CompositeUploads } from "./upload.js";

/** Service backend only. Browser verifiers are exchanged using this project's credential. */
export class CernereComposite {
  readonly sessions: CompositeServiceSessions;
  readonly delegations: CompositeDelegations;
  readonly identity: CompositeServiceIdentity;
  readonly uploads: CompositeUploads;
  private readonly lifetime = new AbortController();
  private projectCredential?: { token: string; expiresAt: number };
  private credentialRequest?: Promise<string>;
  constructor(private readonly config: CompositeConfig) {
    if (!config.clientId || !config.clientSecret || !config.projectKey) throw new Error("Composite project clientId, clientSecret and projectKey are required");
    const authority = new URL(config.cernereUrl);
    if (authority.username || authority.password || authority.search || authority.hash || authority.pathname !== "/"
      || !(authority.protocol === "https:" || (authority.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(authority.hostname)))) {
      throw new Error("Cernere authority must be an HTTPS or loopback HTTP origin");
    }
    this.sessions = new CompositeServiceSessions((action, body) => this.authority(action, body));
    this.delegations = new CompositeDelegations((action, body) => this.authority(action, body), config.projectKey);
    this.identity = new CompositeServiceIdentity((action, body) => this.authority(action, body));
    this.uploads = new CompositeUploads((action, body) => this.authority(action, body), config.projectKey);
  }
  dispose(): void { this.lifetime.abort(); this.projectCredential = undefined; }
  private signal(timeout: number): AbortSignal { return AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(timeout)]); }

  getLoginUrl(origin: string, codeChallenge: string, state: string): string {
    if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge) || !/^[A-Za-z0-9_-]{32,512}$/.test(state)) throw new Error("PKCE challenge and state are required");
    const url = new URL("/composite/login", this.config.cernereUrl);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("origin", new URL(origin).origin);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("state", state);
    return url.toString();
  }

  async exchange(authCode: string, codeVerifier: string): Promise<ExchangeResult> {
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) throw new Error("PKCE verifier is required");
    const credential = await this.credential();
    const response = await fetch(new URL("/api/auth/exchange", this.config.cernereUrl), {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
      body: JSON.stringify({ code: authCode, code_verifier: codeVerifier }), redirect: "error", signal: this.signal(15_000),
    });
    if (!response.ok) {
      if (response.status === 401) this.projectCredential = undefined;
      // The code may already be consumed. Never transparently retry an exchange.
      throw new CompositeAuthorityError(response.status);
    }
    const value = await response.json() as Partial<ExchangeResult> & { accessToken?: unknown; refreshToken?: unknown };
    if (typeof value.projectToken !== "string" || !value.projectToken || value.accessToken !== undefined || value.refreshToken !== undefined
      || !value.user || typeof value.user.id !== "string" || typeof value.user.role !== "string" || typeof value.user.displayName !== "string"
      || (value.user.email !== null && typeof value.user.email !== "string")) throw new Error("Invalid Cernere exchange response");
    return { projectToken: value.projectToken, user: value.user };
  }

  private credential(): Promise<string> {
    if (this.lifetime.signal.aborted) return Promise.reject(new Error("Composite is disposed"));
    if (this.projectCredential && this.projectCredential.expiresAt > Date.now()) return Promise.resolve(this.projectCredential.token);
    if (this.credentialRequest) return this.credentialRequest;
    this.credentialRequest = this.authenticateProject().finally(() => { this.credentialRequest = undefined; });
    return this.credentialRequest;
  }
  private async authority(action: string, body: unknown): Promise<unknown> {
    const credential = await this.credential();
    const response = await fetch(new URL(`/api/auth/service/${action}`, this.config.cernereUrl), {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${credential}` },
      body: JSON.stringify(body), redirect: "error", signal: this.signal(10_000),
    });
    if (!response.ok) {
      if (response.status === 401) this.projectCredential = undefined;
      throw new CompositeAuthorityError(response.status);
    }
    return response.json();
  }
  private async authenticateProject(): Promise<string> {
    const response = await fetch(new URL("/api/auth/login", this.config.cernereUrl), {
      method: "POST", headers: { "content-type": "application/json" }, redirect: "error", signal: this.signal(15_000),
      body: JSON.stringify({ grant_type: "project_credentials", client_id: this.config.clientId, client_secret: this.config.clientSecret }),
    });
    if (!response.ok) throw new Error(`Cernere project authentication failed (${response.status})`);
    const value = await response.json() as { accessToken?: unknown; expiresIn?: unknown; tokenType?: unknown; project?: { key?: unknown } };
    if (value.tokenType !== "project" || typeof value.accessToken !== "string" || typeof value.expiresIn !== "number"
      || !Number.isFinite(value.expiresIn) || value.expiresIn <= 60 || value.project?.key !== this.config.projectKey) throw new Error("Invalid project credential response");
    if (this.lifetime.signal.aborted) throw new Error("Composite is disposed");
    this.projectCredential = { token: value.accessToken, expiresAt: Date.now() + (value.expiresIn - 60) * 1000 };
    return value.accessToken;
  }
}
