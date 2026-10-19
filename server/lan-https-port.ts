/** An explicitly configured second listener preserves the localhost HTTP origin. */
export function resolveLanHttpsPort(value: string | undefined, primaryPort: number, tlsEnabled: boolean): number | null {
  if (!value?.trim()) return null;
  if (!tlsEnabled) throw new Error('OSTIARIUS_LAN_HTTPS_PORT requires TLS_MODE=required');
  if (!/^\d+$/.test(value.trim())) throw new Error('Invalid OSTIARIUS_LAN_HTTPS_PORT');
  const port = Number(value);
  if (port < 1 || port > 65535 || port === primaryPort) throw new Error('LAN HTTPS port must be distinct and within 1..65535');
  return port;
}
