# GLab automatic facility proof

Specification: SPEC-OS-GLAB-AUTO-001.

GLab issues a 60-second HMAC-SHA256 capability only for an authenticated member of a configured facility's organization. The browser POSTs it directly to `/checkin/automatic` under a three-second deadline. Os checks the actual connection against the enrolled venue interface, capability signature, attendance-only purpose, user, facility, gateway, expiry and nonce. It returns an Ed25519 attendance proof (`method=session`, `assurance=low`); it does not record event attendance.

Enable explicitly with Vault bindings `OSTIARIUS_GLAB_ATTENDANCE_SECRET` (at least 32 random characters, shared only with GLab), `OSTIARIUS_GLAB_ORIGIN` (exact HTTPS origin), and `OSTIARIUS_COCOIRU_LAN_INTERFACE`. TLS must be required. Partial configuration fails startup. Existing passkey origin is unchanged. No service restart is part of this code change.

The route is TLS/LAN guarded, rate-limited and has route-specific CORS. Challenges are single use within this process; GLab's durable nonce ledger also rejects replay across gateway restarts. Configure the matching organization/facility/lan ID, gateway public key and HTTPS URL in GLab. Do not include a general Cernere access token in the capability.

This confirms direct venue-LAN access, not physical distance or biometric identity. A timeout is an attendance eligibility result, not definitive evidence of physical absence. Event attendance requires organizer approval in GLab separately.
