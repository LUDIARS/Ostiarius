# Remote Aedilis attendance

Os sends signed attendance to `POST {AEDILIS_BASE_URL}/api/checkin/gateway-verify`.
Ae can run on another machine; no shared filesystem or local Ae process is required.
The deployment URL comes from the service-owned Excubitor catalog (Ae public origin).
`AEDILIS_GATEWAY_TOKEN` is a server-only secret, provisioned with the gateway public key
and facility on Ae. Do not send that token to the browser.

Passkey completion and enabled mobile/session check-in paths return an `attendance`
result. Only `status: recorded` confirms Ae persisted attendance. Missing configuration,
network failure, rejection and malformed responses produce a failure, never a success.
Network requests have a 10-second timeout and reject redirects.
Staff authentication itself does not create attendance.

Face/manual paths retain their existing outbox and return recorded/pending explicitly.
Pending is not recorded; the existing signed-attestation freshness window still applies
to retries. Durable offline attendance beyond that window is outside this change.

Validation: `test/attendance-delivery.test.ts`, `test/mobile-attendance-delivery.test.ts`.
Actual cross-machine checks require a reachable Ae and a provisioned gateway token/key.
