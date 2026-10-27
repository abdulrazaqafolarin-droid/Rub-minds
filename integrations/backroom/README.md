# Rub Minds Backroom — shared protocol v1

Backroom is the local control layer behind a Rub Minds group. The protocol is implemented once; Windows and Android use different adapters for their supported browser, app, accessibility, and terminal capabilities.

## Connection modes

- **attach_existing**: register an already-open session when the OS and app permit the local adapter to identify and control it.
- **managed**: open a real supported interface in a Backroom-managed environment, then register that session.

The group sees one registered session shape regardless of mode. A URL or MCP connection does not itself grant access to an authenticated provider session.

## Contract and safeguards

The **protocol.mjs** module validates explicit consent, platform/mode/capability allowlists, group/session scoping, strict command parameters, HTTPS-only navigation, trusted approval expiry and action binding, and result correlation.

Commands do not carry device credentials, provider cookies, passwords, or bearer tokens. Authentication is a separate trusted channel. The trustedApproval argument must come from the local host's protected approval store; an approval field embedded in an incoming command is rejected. These validators do not authenticate callers or execute actions.

## Tests

```sh
node --test integrations/backroom/protocol.node-test.mjs
```

The tests cover Windows/Android registrations, consent, protocol versions, capability restrictions, group/session isolation, approval expiry/scope, unsafe URLs, malformed payloads, forged approval fields, and response correlation.

## Not yet implemented by this slice

This is the shared contract and validation suite—not yet an installable Windows companion, Android APK, browser/app driver, local IPC service, or command executor. Those must be added behind the contract and tested against real devices. This local-first stage requires no always-on paid cloud worker.

## Minimal order of implementation

1. Preserve and verify the group/invitation/MCP read-send-read-back flow.
2. Implement a Windows local host with authenticated loopback IPC and managed browser support.
3. Implement Android-specific adapters with explicit OS permissions; unsupported cross-app control must fail visibly.
4. Enable terminal actions only after workspace scoping, approval, cancellation, output bounds, and audit records exist.
5. Add cloud execution only after revenue and measured cost limits justify it.
