# Preserve localhost authentication while adding LAN HTTPS

The LAN hostname is a transport address, not an instruction to migrate passkey RP IDs.
Existing OSTIARIUS_RP_ID and OSTIARIUS_PWA_ORIGIN remain unchanged.

With TLS_MODE=required and optional OSTIARIUS_LAN_HTTPS_PORT set to a distinct valid
port, the original listener serves HTTP on 127.0.0.1 only. A second listener serves
the same hardened application over HTTPS on the configured LAN port. Both close
on shutdown. Without this option, existing single-listener behavior is unchanged.
The advertised LAN URL uses the HTTPS port. Host checks accept only explicitly
configured ports and existing allowed hostnames. CORS, nonce, LAN, token and
passkey checks remain enforced. Passkey operations under the LAN hostname still
require matching RP/origin and are not silently enabled by this transport option.

Deployment must allocate the second port through the service-owned catalog before
Vault enablement, retain the localhost HTTP health probe, bind certificate variables,
and verify both listeners through Excubitor on the main checkout. Certificate
verification must remain enabled. Unit tests do not replace real socket checks.

Human scope: existing login must be preserved while enabling the chosen LAN-check
hostname; linked Actio runtime task 236414d2-f2a9-449e-8015-8c507a256120.
