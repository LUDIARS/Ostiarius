// C-20 buildSecurityHeaders(scriptNonce)
//
// 全応答に付ける防御ヘッダ。inline script は nonce でだけ許し、'unsafe-inline' を script に使わない。

export default {
  post: (headers: Record<string, string>, scriptNonce: string) => {
    const csp = headers['content-security-policy'] ?? '';
    if (!csp.split(';').map((part) => part.trim()).includes("default-src 'self'")) return "CSP must start from default-src 'self'";
    const scriptSrc = csp.split(';').map((part) => part.trim()).find((part) => part.startsWith('script-src')) ?? '';
    if (scriptSrc.includes("'unsafe-inline'")) return 'inline scripts must be allowed by nonce only';
    if (!scriptSrc.includes(`'nonce-${scriptNonce}'`)) return 'the script nonce must be part of script-src';
    if (headers['x-frame-options'] !== 'DENY') return 'framing must be denied';
    if (headers['x-content-type-options'] !== 'nosniff') return 'MIME sniffing must be disabled';
    return headers['referrer-policy'] === 'no-referrer' || 'referrers must not be sent';
  },
};
