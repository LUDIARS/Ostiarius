/** @implements SPEC-OS-KIOSK-PROXIMITY-LOGIN
 * Deployment prerequisites only. Browser/OS support still needs a real-device check. */
export function proximityOriginAllowed(requestUrl: string, expectedOrigin: string, rpId: string): boolean {
  try {
    const url = new URL(requestUrl);
    const secure = url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost');
    return secure && url.origin === new URL(expectedOrigin).origin &&
      (url.hostname === rpId || url.hostname.endsWith('.' + rpId));
  } catch {
    return false;
  }
}
