# Cocoiru native session configuration — not applied

SPEC-OS-COCOIRU-SCOPED-NATIVE-001. Configuration changes and service operations
are outside this implementation; the all-consumer cutover is still held.

If OSTIARIUS_COCOIRU_LAN_INTERFACE is absent the optional native/checkin routes
stay absent. Enabling it requires existing trusted venue TLS, selected interface,
canonical HTTPS OSTIARIUS_PWA_ORIGIN, CERNERE_PROJECT_KEY and registered project
client ID/secret. No static CERNERE_SERVICE_TOKEN can replace those credentials.
Reuse facility UUID and lanId from existing startup configuration; no client can
select them in a request. Preserve all unrelated Vault entries and other routes.

The Cr administrator must verify the project's current managed hub_url equals
the configured Os origin, its composite_origins explicitly permit the Cocoiru
broker origin, the project is active, and its schema declaration includes:

```json
{
  "service_operations": [
    { "action": "attendance.cocoiru.attest", "risk": "important", "permissions": ["attendance.cocoiru.attest"] }
  ]
}
```

This is one addition to the current declaration, not a replacement of the whole
schema or existing operations. The user must explicitly grant the corresponding
service_operation.attendance.cocoiru.attest permission. Missing policy/consent
must deny; identity.basic alone cannot grant proof issuance. Do not infer an
audience from transport endpoints or register an arbitrary client-supplied URL.

Cocoiru public settings select Os's own origin/client ID separately from GLAB.
Never copy project secrets to the host/UI. Native exchange/logout keep their
ambient-cookie-free Bearer boundary and existing transport/Host/Origin hardening.
Exchange also uses the existing IP rate limiter; checkin rechecks the live actual
selected-interface subnet, including after remote permission preparation.

Before any authorized coordinated switch, verify the published SDK/source pins,
admin policy/consent/origin settings, gateway-key provisioning in GLAB, real
desktop exchange/logout/expiry, physical venue LAN and TLS, same-account subject
matching and recorded/already-checked-in results. Existing mobile/PWA/kiosk/face
callers need their separate migration. Neither source tests nor this checklist
are evidence that settings or runtime have already been verified.
