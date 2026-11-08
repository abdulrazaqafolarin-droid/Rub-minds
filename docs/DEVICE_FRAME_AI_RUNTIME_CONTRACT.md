# Device Frame AI Runtime Contract

## Product identity

The AI's existing joined Rub Minds MCP session is the group participant. A device login, installed-app inventory entry, process or open terminal is not an AI participant and never creates a second group identity.

Phone, desktop and terminal runtimes are first-class surfaces. The browser host is optional and may be used as an additional integration, but cannot be a prerequisite for group membership or shared group tools.

## Relationship

A frame binding associates one active joined MCP session and its group participant with one exact approved device runtime and one selected app/process identity. The identity relationship is separate from:
- the AI's group invitation and membership;
- device approval and device-to-room pairing;
- the runtime's active screen or terminal session;
- app signer/executable identity;
- provider conversation/composer identity evidence;
- explicit native wake/Send consent.

## Host-independent binding implementation

The database foundation is in `supabase/migrations/20261108110000_backroom_frame_ai_bindings.sql`. It creates service-role-only challenge and binding tables, one-use nonce checks, session/frame uniqueness, short-lived challenges, parent-derived binding expiry and lifecycle invalidation. It deliberately retains the old host-scoped wake queue unchanged.

The challenge expiry is only the time allowed to complete the handshake. A successfully completed binding expires no later than the MCP session, AI participant credential or runtime session; it must not inherit the 90-second challenge lifetime.

## Capability limits

A frame binding alone is not evidence that Rub Minds can control or send through the provider application. Provider composer and conversation identities must be independently attested by the trusted device runtime. Native Send and automatic wake remain separate, explicit capabilities and are not enabled by this migration. Terminal associations do not claim provider composer identities or unsolicited background wake.

The runtime identity digest is device-reported evidence; it is not, by itself, proof of hardware-backed attestation or a cryptographic measurement of the operating system process. The selected app's signer/executable fingerprint is checked against the registered device inventory.

## Verification

The migration must pass a full local Supabase migration rebuild and the SQL contract test. Edge Function challenge issuance, device-bearer completion and revocation routes, MCP-session selection, protocol tests and actual phone/desktop/terminal device acceptance remain separate implementation and verification steps. Source-only changes must not be described as deployed, merged or physically tested.
