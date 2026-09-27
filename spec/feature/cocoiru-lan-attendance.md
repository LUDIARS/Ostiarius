# Cocoiru LAN attendance (GLab G2)

Actio: 721d8fef-f8c3-48e9-b242-0c12efbe529a.
2026-09-27 neco: 接続SSIDがvantanまたはテスト名ならOsへ要求し、同一LANなら出席。

Cocoiru checks the connected SSID exactly (default: vantan; optional explicit test name).
SSID is a trigger, not evidence of attendance. Os verifies the actual socket peer belongs
to the subnet of the explicitly selected venue interface and rejects proxy headers,
loopback/internal interfaces, other interfaces and unavailable socket information.
This is subnet reachability evidence, not physical-location or anti-relay proof; the
venue network must not expose this interface through VPNs, NAT relays or tunnels.

Set OSTIARIUS_COCOIRU_LAN_INTERFACE to the OS venue interface name. The endpoint stays
absent if unset. HTTPS with a trusted venue certificate is required; enabling the
interface with TLS disabled fails startup. An unknown interface cannot issue proofs.
No runtime configuration or service restart is part of this change.

POST /checkin/cocoiru requires the user's Cernere Bearer access token (no userId in body).
Os validates it through /api/auth/me, then returns {attestation}. Token validity alone
cannot bypass the LAN guard. Requests to Cr have a 10-second timeout and no redirects.
The proof retains method=session, assurance=low, nonce, issuedAt, placeId and lanId;
it never claims biometric/passkey assurance. The response is no-store.

Cocoiru passes the proof to GLAB POST /api/x/attendance/checkin using the same user token.
Only GLAB's successful recorded/alreadyCheckedIn result counts as attendance. Os's
proof response alone does not mean a record exists. Existing gateway-key provisioning,
subject matching, freshness and replay protection remain mandatory.

Acceptance: allowed connected SSID + same venue subnet + valid user + GLAB confirmation
records attendance; wrong SSID, outside subnet, proxy, invalid session, untrusted TLS,
missing configuration and downstream failures never become success. Test execution
and test-file creation remain pending human authorization; typecheck only in this change.
