/** @implements SPEC-OS-COCOIRU-SCOPED-NATIVE-001 */
export interface CocoiruNativeConfig {
  interfaceName: string; publicOrigin: string; projectKey: string; clientId: string; clientSecret: string;
}
/** Pure validation, before DB/startup side effects. No static-token fallback. */
export function cocoiruNativeConfig(env: NodeJS.ProcessEnv, tlsEnabled: boolean): CocoiruNativeConfig | null {
  const interfaceName = env.OSTIARIUS_COCOIRU_LAN_INTERFACE?.trim();
  if (!interfaceName) return null;
  if (!tlsEnabled) throw new Error('Cocoiru attendance requires venue TLS');
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(name + ' is required for Cocoiru native sessions');
    return value;
  };
  const publicOrigin = required('OSTIARIUS_PWA_ORIGIN');
  let origin: URL;
  try { origin = new URL(publicOrigin); } catch { throw new Error('Canonical HTTPS Os public origin required'); }
  if (origin.protocol !== 'https:' || origin.origin !== publicOrigin || origin.username || origin.password) throw new Error('Canonical HTTPS Os public origin required');
  const projectKey = required('CERNERE_PROJECT_KEY'), clientId = required('CERNERE_PROJECT_CLIENT_ID');
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(projectKey) || !/^[A-Za-z0-9._~-]{1,200}$/.test(clientId)) throw new Error('Invalid registered native project identity');
  return { interfaceName, publicOrigin, projectKey, clientId, clientSecret: required('CERNERE_PROJECT_CLIENT_SECRET') };
}
