/** Cr-owned resources restricted to the current scoped session's own native account.
 * @implements SPEC-COMPOSITE-SCOPED-IDENTITY
 */
import { prepareServiceOperation, type AuthorityCall, type BoundServiceSession, type ServiceOperationRisk } from './service-session.js';

export interface OwnOrganizationMembership { id: string; name: string; role: string }
export interface OwnFaceConsent { facilityId: string; consentId: string; policyVersion: string; at: string; reconsentRequired: boolean }
/** The service must check its current local owner after asynchronous permission work. */
export interface ScopedIdentitySession { grant: BoundServiceSession; isCurrent: () => boolean }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CompositeServiceIdentity {
  constructor(private readonly call: AuthorityCall) {}

  async organizations(session: ScopedIdentitySession): Promise<OwnOrganizationMembership[]> {
    const value = await this.execute(session, 'identity-organizations', 'identity.organizations.read', 'self:organizations', 'sensitive_read', {}) as { items?: unknown } | null;
    if (!value || !Array.isArray(value.items) || value.items.length > 1000) throw new Error('Invalid own membership result');
    return value.items.map((row: unknown) => {
      const item = row as Partial<OwnOrganizationMembership> | null;
      if (!item || typeof item.id !== 'string' || !uuid.test(item.id) || typeof item.name !== 'string' || typeof item.role !== 'string') throw new Error('Invalid own membership result');
      return { id: item.id, name: item.name, role: item.role };
    });
  }
  async faceConsentStatus(session: ScopedIdentitySession): Promise<OwnFaceConsent[]> {
    const value = await this.execute(session, 'identity-face-consent-status', 'identity.face-consent.read', 'self:face-consent', 'sensitive_read', {}) as { items?: unknown } | null;
    if (!value || !Array.isArray(value.items) || value.items.length > 1000) throw new Error('Invalid own consent result');
    return value.items.map((row: unknown) => {
      const item = row as Partial<OwnFaceConsent> | null;
      if (!item || typeof item.facilityId !== 'string' || !uuid.test(item.facilityId) || typeof item.consentId !== 'string' || !uuid.test(item.consentId)
        || typeof item.policyVersion !== 'string' || typeof item.at !== 'string' || !Number.isFinite(Date.parse(item.at)) || typeof item.reconsentRequired !== 'boolean') {
        throw new Error('Invalid own consent result');
      }
      return { facilityId: item.facilityId, consentId: item.consentId, policyVersion: item.policyVersion, at: item.at, reconsentRequired: item.reconsentRequired };
    });
  }
  async createFaceConsent(session: ScopedIdentitySession, facilityId: string, policyVersion: string): Promise<void> {
    if (!uuid.test(facilityId) || !policyVersion || policyVersion.length > 128) throw new Error('Facility and current consent policy are required');
    const value = await this.execute(session, 'identity-face-consent-create', 'identity.face-consent.create', 'self:face-consent', 'important', { facilityId, policyVersion }) as Record<string, unknown> | null;
    if (!value || typeof value.consentId !== 'string' || !uuid.test(value.consentId) || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))
      || value.facilityId !== facilityId || value.policyVersion !== policyVersion) throw new Error('Consent creation was not confirmed');
  }
  async revokeFaceConsent(session: ScopedIdentitySession, facilityId?: string): Promise<void> {
    if (facilityId !== undefined && !uuid.test(facilityId)) throw new Error('Invalid consent facility');
    const value = await this.execute(session, 'identity-face-consent-revoke', 'identity.face-consent.revoke', 'self:face-consent', 'important',
      facilityId === undefined ? {} : { facilityId }) as { ok?: unknown } | null;
    if (value?.ok !== true) throw new Error('Consent revocation was not confirmed');
  }
  private async execute(session: ScopedIdentitySession, route: string, action: string, resource: string, risk: ServiceOperationRisk, input: Record<string, string>): Promise<unknown> {
    const current = (): void => {
      if (typeof session.isCurrent !== 'function' || session.isCurrent() !== true) throw new Error('Local identity session owner ended');
    };
    current();
    const grant = session.grant;
    const payload = JSON.stringify(input);
    const permission = await prepareServiceOperation(this.call, grant, { action, resource, body: payload }, risk);
    current();
    // The data endpoint itself consumes the permit, then executes once. No retry.
    const value = await this.call(route, { projectToken: grant.projectToken, sessionBinding: grant.sessionBinding,
      requestId: permission.body.requestId, permit: permission.permit, payload }) as Record<string, unknown> | null;
    current();
    if (!value || value.requestId !== permission.body.requestId || value.risk !== risk || !Object.hasOwn(value, 'data')
      || ['accessToken', 'refreshToken', 'projectToken', 'sessionToken'].some(key => Object.hasOwn(value, key))) throw new Error('Invalid scoped identity response');
    return value.data;
  }
}
