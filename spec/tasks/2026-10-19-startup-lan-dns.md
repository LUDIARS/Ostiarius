---
task: Startup LAN DNS synchronization
project: Os
kind: implementation
created: 2026-10-19
memory_links: []
---

Human instruction: automatically obtain the LAN IP and update DNS when Os starts.
This extends the existing authentication runtime task
`actio:236414d2-f2a9-449e-8015-8c507a256120` and is linked through Cc as
`conversation:neco:2026-10-19:os-startup-lan-dns`.

Design and acceptance: [startup-lan-dns](../feature/startup-lan-dns.md).
Implementation uses isolated address selection, configuration, Cloudflare synchronization
and startup orchestration modules. Test doubles never contact Cloudflare.
Deployment requires Vault bindings and a verified venue adapter before enabling the mode.
The existing credential retrieval endpoint returned HTTP 530 during the earlier certificate
attempt; this change does not bypass that endpoint or provision new credentials.
