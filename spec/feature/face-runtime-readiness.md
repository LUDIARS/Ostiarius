# Face runtime readiness

The 2026-10-18 request is to exercise all Os authentication methods on a
development PC before deployment to the target facility. This change
fixes the observed `uvicorn` command-not-found startup failure; it does not claim
physical face recognition acceptance or implement the Vultus geometry proposal.

Excubitor starts `face-sidecar/scripts/start.mjs` from the main project only. The
launcher uses `.venv/Scripts/python.exe` on Windows and `.venv/bin/python` elsewhere,
executes `python -m uvicorn` without a shell, binds loopback, and propagates failure.
It owns and terminates its child on shutdown. Provision Python >=3.11 and install
the declared dependencies into that dedicated environment before startup.

Model files and applicable licenses remain separate prerequisites. A live process
whose sidecar health is `ok:false` is not an available authentication method.
Do not weaken matching, consent, liveness, TLS or attendance-assurance checks to
make a readiness indicator green.

Verification: launcher command validation tests do not start a service. Physical
recognition, enrollment, spoof rejection and accepted attendance delivery require
the main-folder Excubitor workflow and explicit user participation.

## Verification record (2026-10-18)

- Existing main `4c2d735`: TypeScript check passed; all 49 Vitest files / 387
  tests passed. These use software fixtures and do not certify physical identity.
- Launcher tests: 2 passed, executed with cwd in the main project; no service
  was started from the worktree. Anatomia staged-diff verification passed.
- Before this change, an Excubitor start of the face sidecar failed immediately:
  `uvicorn` was not found. A dedicated Python 3.11 environment is being provisioned.
- Password/session compatibility remains gated by TLS and explicit configuration.
  Staff fallback requires an enrolled authorized staff credential. NFC/FeliCa
  remains unavailable. None of these gates is removed by this runtime fix.
