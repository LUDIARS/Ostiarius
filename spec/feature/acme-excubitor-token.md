# ACME Cloudflare token from Excubitor

The issue/renew CLI obtains `CLOUDFLARE_DNS_API_TOKEN` from the existing authenticated
Excubitor secret-agent if no explicit environment/CLI token was supplied. No
Infisical request, arbitrary project lookup, Vault decryption or plaintext file is used.

Prerequisites:
- Bind the existing Cloudflare project `CLIENT_SECRET` to tool identity `ostiarius-acme` in Excubitor Vault. This separate tool binding preserves the main Os project binding.
- Set `EXCUBITOR_URL` to the local backend HTTP(S) origin from the Ex configuration.
  Only loopback origins are accepted; localhost is pinned to 127.0.0.1 without DNS.
  No hardcoded port or remote fallback.
- The Ex agent token is read from `EXCUBITOR_AGENT_TOKEN`, or the existing file at
  `EXCUBITOR_AGENT_TOKEN_PATH`, or Ex's standard APPDATA/XDG_CONFIG_HOME/.config
  `Excubitor/secret-agent.token` path. The CLI never generates or modifies this file.

POST `/api/v1/secrets/resolve` requests only tool identity `ostiarius-acme` and the Cloudflare
key. Missing binding, authentication failures, unavailable Ex or invalid responses
fail explicitly. Responses and credentials are never printed. Redirects are refused,
requests time out after 10 seconds, no automatic retries occur. The token stays in
process memory and is not written into process.env or a temporary file.

The existing `tls:issue` and `tls:renew` commands and flags remain unchanged.
CLI validation precedes secret retrieval. Success instructions name Excubitor Vault.
Mocked tests exercise override precedence, scoped requests, file-based auth,
endpoint restrictions and sanitized errors. Actual certificate issuance is separate.

Provider contract: Excubitor/spec/feature/secret-agent.md and src/secrets/agent-token.ts.
Instruction: conversation:neco:2026-10-19:ex-acme-token; linked runtime task
actio:236414d2-f2a9-449e-8015-8c507a256120.
