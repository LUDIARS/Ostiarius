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

POST /checkin/cocoiru now requires the Os-owned opaque native Bearer established
by project-bound PKCE exchange; [scoped native sessions](cocoiru-scoped-native-session.md)
supersedes the old global user-token verification. No userId is body-owned, no
/api/auth/me fallback remains in this endpoint, and the shared Cr SDK consumes
an important one-use permit before current LAN/session checks and proof issuance.
Token validity alone cannot bypass the LAN guard. SDK requests are bounded and
never follow redirects.
The proof retains method=session, assurance=low, nonce, issuedAt, placeId and lanId;
it never claims biometric/passkey assurance. The response is no-store.

Cocoiru passes the proof to GLAB POST /api/x/attendance/checkin using a separate
GLAB-owned opaque service session, representing the same Cr account.
Only GLAB's successful recorded/alreadyCheckedIn result counts as attendance. Os's
proof response alone does not mean a record exists. Existing gateway-key provisioning,
subject matching, freshness and replay protection remain mandatory.

Acceptance: allowed connected SSID + same venue subnet + current scoped user + GLAB confirmation
records attendance; wrong SSID, outside subnet, proxy, invalid session, untrusted TLS,
missing configuration and downstream failures never become success. Test execution
is delegated to Revisor in the current explicit Cr implementation request; the
agent does not run tests or start services. Physical LAN/recorded attendance and
coordinated cutover remain pending.
