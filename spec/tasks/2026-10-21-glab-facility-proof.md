---
task: Issue GLab automatic facility attendance proofs
project: Os
kind: feature
created: 2026-10-21
memory_links: []
---

Requested by neco: automatically check facilities belonging to the logged-in user's organizations when GLab attendance opens. Issue user-bound same-LAN proofs without distributing reusable user credentials. Event attendance requires the organizer's explicit approval and is not confirmed by Os arrival verification.

See `spec/feature/glab-automatic-facility-attendance.md` for the wire contract, configuration and limits. Validate invalid/expired/wrong-facility challenges, replay, non-LAN requests and valid Ed25519 proof issuance. Deployment requires explicit Vault configuration on both services; no runtime configuration has been activated by this implementation.
