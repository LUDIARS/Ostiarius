# Service-bound Cocoiru attendance

SPEC-OS-COCOIRU-SCOPED-NATIVE-001. Parent Cr e0acdef1, Os65006163 and
Cocoiru03700b9e track this required consumer separately from deployment.
Cocoiru3674 accepts one opaque session per service, with GLAB and Os separate.
This supersedes cocoiru-lan-attendance's global user-token authentication only.

Only the explicitly enabled Cocoiru LAN endpoint and its native exchange/logout
are migrated. Existing mobile/PWA, passkey, kiosk, face, MFA, proximity and venue
registration retain their separate tasks and purpose boundaries. Do not un-block
old GLAB G2 721d or declare those consumers migrated from this change.

Native exchange accepts JSON code plus S256 verifier, authenticates the configured
project with the accepted Cr SDK and binds one random opaque local session.
The response contains only that token and <=900second expiry. No Cr user access
or refresh token, cookie, profile or local device UUID is accepted or returned.
Use the server-only exact SDK snapshot from accepted71d6c368, MIT, with no new
runtime dependency. Do not handwrite token verification, signing or PKCE.

The process-owned bounded map retains only scoped project grant and fingerprinted
opaque handle, never positive authorization caches. At most32 creations may be
pending and10,000 local sessions exist. Existing transport hardening protects
native exchange/logout and the existing IP limiter covers exchange.
Exchange/bind execute once;
capacity, duplicate, cancellation, expiry and unknown outcomes cannot publish a
second local session. Logout removes local authority before remote revocation;
unknown remote results remain explicit. Shutdown closes the store and SDK owner.

Each checkin uses the exact empty JSON request bytes, important action
attendance.cocoiru.attest and a resource fixed to the configured facility/lanId.
The shared SDK checks the live bound user/session and consumes a single current
permit. No user ID, facility, risk, target, timestamp or assurance is body-owned.
Unknown query/method/credential shapes are refused. Cr denial/unavailability
never returns to /api/auth/me or another token format. Do not retry unknown
authorization, consumption, exchange or signed-proof results automatically.

Resource authorization immediately before issuance checks the same local session,
unexpired grant, un-aborted request, current configured venue interface and actual
socket local/remote addresses. Preserve private-subnet/interface/proxy rejection;
client SSID/local installation ID, loopback or another interface cannot grant
attendance. Venue TLS remains required. Native exchange is same-LAN; logout may
revoke an existing bearer after leaving the venue, without granting a proof.

After remote permission finishes, a synchronous short SQLite transaction owns
current local authorization, existing audit insertion and existing attestation
signing. No remote await occurs inside that transaction. Only successful commit
can disclose a proof. Preserve nonce freshness and GLAB's independent signature,
subject/current GLAB user, age and replay checks. Os's proof alone records no
attendance. Format remains purpose=attendance/method=session/assurance=low; no
kiosk/MFA/registration/high assurance is inferred from a native session.

When the Cocoiru interface is enabled, TLS, canonical HTTPS public Os origin,
project key, project client ID/secret and explicit Cr important-operation
declaration are required. Administrator hub_url/composite origins/consent must
match. This change applies no settings, installs no service, starts no runtime
and performs no coordinated cutover. Existing alternate consumers and physical
LAN/desktop/recorded-attendance acceptance remain pending.
