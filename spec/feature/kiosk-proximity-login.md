# SPEC-OS-KIOSK-PROXIMITY-LOGIN

Instruction: neco, 2026-10-18. Provide Kiosk authentication for people unable to
log in through Cocoiru, using Bluetooth proximity or iPhone/Android FeliCa.
Follow-up instruction: proceed with implementation including tests. Implement the
facility attendance path first using browser/OS hybrid passkeys. Hardware approval
and real-device verification are separate; FeliCa remains explicitly unavailable.

## Implemented path

The Kiosk offers smartphone passkey confirmation without a Cocoiru session.
`GET /kiosk/proximity/capabilities` reports deployment prerequisites only.
`POST /kiosk/proximity/:sessionId/begin|finish` requires Kiosk authorization,
same-origin JSON requests, LAN-sensitive-route protection and existing rate limits.
The configured PWA origin and RP ID must match the Kiosk browser context. A
localhost Kiosk with a different Cernere RP ID is explicitly unavailable; configure
a compatible trusted HTTPS Kiosk origin rather than weakening WebAuthn checks.

The route uses a dedicated 60-second challenge store and passes hybrid transport
and browser hints, with user verification required. Finish is bound to the same
unexpired identity session. Concurrent submissions are rejected, consumed
challenges cannot be replayed, and an issued session cannot issue again.
Attendance delivery failure does not mark the session successful. Responses
retain `method=passkey`, `assurance=medium`, `purpose=attendance`; the server does
not claim to have independently measured Bluetooth proximity. No Cr MFA nonce
is completed by this route. The browser times out/cancels before submission and
shows an uncertain-result message if a submitted operation cannot be confirmed.

Implementation: `server/routes/kiosk-proximity.ts`, `kiosk-proximity-panel.ts`,
`server/proximity-capability.ts`, shared `server/passkey-checkin.ts`.
Regression: `test/kiosk-proximity.test.ts`, identity and onsite-MFA suites.

## Existing boundaries

At baseline `4091c7a`, `server/passkey-checkin.ts` verifies Cernere-synchronized
public keys, required user verification, RP ID, origin and one-use challenges.
`server/routes/kiosk.ts` currently directs attendance users to a phone web page.
`server/routes/onsite-mfa-kiosk.ts` also supports Kiosk passkey assertions, but
its completion sends purpose=mfa to Cernere and must not record attendance.
`server/kiosk-authorization.ts` restricts Kiosk operations to authorized transport.
These boundaries must remain intact; a nearby device is not itself an identity.

## Candidate Bluetooth path

Prefer browser/OS FIDO cross-device passkey authentication (hybrid transport).
Bluetooth proves proximity; a registered passkey signature and user verification
prove identity. Do not invent authentication from MAC addresses, names or RSSI.
The browser controls pairing/QR/phone selection; successful WebAuthn alone must
not be labelled Bluetooth-verified unless that property is actually established.

Before implementation, confirm Kiosk OS/browser, Bluetooth availability, target
login purpose and enrolled smartphone credentials. Validate secure context and
RP ID/origin compatibility: localhost does not automatically satisfy Cernere's
RP ID. Do not weaken origin checks to make deployment work. Hybrid transport may
need Internet connectivity; do not promise the existing offline behavior for it.

People without an enrolled usable credential still need the existing supervised
recovery/enrollment path. This feature does not bypass Cernere account recovery.

## FeliCa decision boundary

Android NFC-F HCE requires NFC-F hardware and an application implementing the
protocol. General NFC support alone is insufficient. Apple NFC & SE Platform
requires eligible use cases, authorization and compatible hardware; its general
availability does not establish arbitrary FeliCa emulation support.

Confirm reader model, intended credential (existing transit card versus a new
managed credential), provisioning rights and device coverage before choosing a
protocol. IDm/UID alone is a lookup hint, not a secure login factor. A production
path needs issuer-approved proof of possession, account binding, revocation,
one-use challenge, expiry and audience/session binding. Existing payment or
transit credentials must not be assumed reusable as application login keys.

## Open decisions

1. Kiosk OS/browser and reader/Bluetooth hardware.
2. Implemented scope is facility attendance/login at the Kiosk. Approving Cr
   login on another device remains the existing onsite MFA path; it is not changed.
3. If FeliCa is selected: credential and provisioning model, iPhone support and
   reader integration. No automatic fallback to ID-only authentication.

## Acceptance items (all not executed)

| ID | Scenario | Required result |
|---|---|---|
| PROX-01 | Registered iPhone/Android passkey, supported Kiosk | Correct account verified; Cocoiru app/session not required |
| PROX-02 | Bluetooth unavailable, denied or phone absent | Clear recovery guidance; no success or weaker silent fallback |
| PROX-03 | User cancels or biometric/PIN verification fails | No login or attendance side effect |
| PROX-04 | Unknown/revoked credential | Rejected; no account created implicitly |
| PROX-05 | Expired/replayed assertion | Rejected and no duplicate side effect |
| PROX-06 | Wrong origin/RP ID/session/audience | Rejected without relaxing validation |
| PROX-07 | Two users/Kiosk sessions overlap | No cross-user completion; abandoned session expires |
| PROX-08 | Attendance versus MFA completion | Only selected purpose receives the signed result |
| PROX-09 | Unsupported iPhone/Android NFC capability | Explicitly unavailable; no claim of FeliCa support |
| PROX-10 | Copied IDm, unknown reader or forged bridge input | Cannot authenticate a user |
| PROX-11 | Lost phone/card revoked and used again | Rejected according to documented sync/revocation policy |
| PROX-12 | Network loss/host restart during confirmation | No stale success; retry is bounded and idempotent |
| PROX-13 | Completed/cancelled flow on shared Kiosk | Clear private UI state; no tokens, keys or personal data in logs |

Testing requires the separate execution authorization and Excubitor/Concordia
claim workflow; use only the project main directory. Record results in the
corresponding TestWorkflow thread. This document is not an Augur registration.

## Evidence

- Pf: project `01M3FVMG2MB1XZ8WEEZ8ATZDMR`, UX goal revision 1 (draft facility
  check-in goal, not proof of this feature's approval or implementation).
- Anatomia project `ostiarius`: context returned onsite MFA clauses and
  checkin-verification/cernere-integration domains. `plan --no-llm` failed with
  `knowledge log must use LF line endings`; no successful generated plan claimed.
- FIDO: https://fidoalliance.org/passkeys/
- Apple: https://developer.apple.com/support/nfc-se-platform
- Android: https://source.android.google.cn/docs/core/connect/felica?hl=en
