# Kiosk proximity verification

Scope: SPEC-OS-KIOSK-PROXIMITY-LOGIN, supporting domain `kiosk-proximity` and
existing `checkin-verification`. Request: neco explicitly authorized implementation
including tests on 2026-10-18. Authoritative task: Actio
`e7040eb3-5f60-4b2b-bba4-8397e4e5d90f`.

The quality bar is a signed-assertion-to-attendance path plus rejection of
unauthorized, replayed, cross-session and expired input. Physical Bluetooth
behavior is a separate acceptance condition, not proved by simulated assertions.

## Executed on 2026-10-18

- TypeScript: `tsc --noEmit -p tsconfig.json` — passed.
- Vitest: `test/kiosk-proximity.test.ts`, `test/identity.test.ts`,
  `test/onsite-mfa.test.ts`, `test/kiosk-loopback.test.ts`,
  `test/lan-http-hardening.test.ts`, `test/checkin.e2e.test.ts` — **79 passed,
  6 files**, 14:23 JST. Uses in-memory Hono requests, SQLite and a software
  authenticator; no listening service or physical phone was started.
- Concordia testing claim/release surrounded execution; release confirmed.
- `git diff --check` — passed.
- Anatomia `verify --repo <task-worktree> --diff -` on staged changes — passed
  rule_conformance, duplication, spec_linkage, coupling_delta and convention_drift.
- Anatomia `context` / `where` for registered `ostiarius` located the existing
  verification and Cr integration boundaries. `plan --no-llm` was blocked by a
  pre-existing knowledge log with non-LF line endings. Installed CLI has no
  `test-suggestions` subcommand. These are not reported as successful checks.
- Augur plan consumed the local diff and suggested happy path, consumer contract,
  and invalid/boundary cases; the new test file covers those categories. This is
  not a complete Augur ledger registration for the repository.

## Pending physical acceptance

Use the PROX acceptance matrix in the feature spec. Confirm compatible Kiosk
origin/RP ID, browser/OS and enrolled iPhone/Android credentials; exercise browser
hybrid selection, Bluetooth off, cancellation, loss of connectivity and an
actual facility recording. Execute only from the project main directory via
Excubitor, with a Concordia testing claim, and record evidence in the PR's
TestWorkflow thread. Never record tokens, credential material or personal data.

FeliCa is explicitly unavailable, pending a reader and credential/provisioning
contract. No physical Bluetooth, FeliCa, runtime deployment or user experience
acceptance is claimed by the automated results above.
