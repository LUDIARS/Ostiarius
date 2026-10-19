# Startup LAN DNS synchronization

## Purpose and acceptance

At each Os process start, publish the selected venue adapter's current RFC1918 IPv4
to the configured Cloudflare hostname. This supports changing DHCP leases without
reissuing a hostname certificate. It does not establish same-SSID membership.

Enable through Excubitor Vault bindings:

- `OSTIARIUS_LAN_DNS_MODE=cloudflare` (default `off` for existing installations)
- `OSTIARIUS_LAN_HOSTNAME=os-lancheck.ai-run-do.com`
- `OSTIARIUS_LAN_DNS_ZONE_ID`: the Cloudflare zone ID for the hostname
- `OSTIARIUS_LAN_DNS_INTERFACE`: exact venue adapter name, e.g. `Wi-Fi`
- `CLOUDFLARE_DNS_API_TOKEN`: zone-scoped Zone Read and DNS Edit token; never commit its value

The selected adapter must have exactly one non-internal private IPv4. Missing or
ambiguous addresses fail startup rather than choosing a VPN or virtual adapter.
The configured hostname must belong to the configured zone and cannot be its apex.
Create one DNS-only A record with TTL 120 when absent. Update only the content of
an existing single DNS-only private A record, preserving its metadata. An unchanged
IP performs no write. CNAME, AAAA, public A, proxied or multiple address records
are conflicts, never automatically replaced. TXT records are left alone.

Synchronization runs before database, key generation, timers and listeners. Enabled
mode with invalid configuration, unavailable API, or conflicting DNS fails startup.
Every request has a 10 second timeout, disallows redirects, and redacts remote error
bodies. Writes are read back through the API; indeterminate writes are not retried
within the process. On restart the current DNS state is read first.
`/api/health.startupLanDns` exposes `off`, `created`, `updated` or `unchanged`
for the startup result; it does not promise continued DNS freshness.

This is startup-only: lease changes while running require a restart. DNS caches
may retain old answers until their TTL expires. API read-back does not prove client
DNS propagation. Router DNS-rebinding protection may reject private public-DNS
answers. The certificate, TLS runtime configuration and LAN firewall remain separate
deployment requirements. Never expose this attendance gateway through a Tunnel.

## Verification

Mocked tests cover changed/unchanged/absent records, conflicting DNS, timeout/failure,
read-back mismatch, token redaction, configuration and adapter ambiguity. No test
modifies real DNS or starts the application from a worktree.

Local verification: 14 mocked tests passed; TypeScript type checking passed.
Real Cloudflare writes, client DNS propagation and runtime enablement remain unverified.

API contract: https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/edit/

Investigation: Anatomia plan was attempted but unavailable due to a knowledge-log
LF validation error. TypeScript language server was not installed on the work host;
source references were inspected with rg. Existing `server/lan-route.ts` is for
display URL detection; publication deliberately uses an explicitly selected adapter.
