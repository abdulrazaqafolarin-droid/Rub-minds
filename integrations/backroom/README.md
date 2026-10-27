# Rub Minds Backroom — shared protocol v1

Backroom is the local control layer behind a Rub Minds group. The protocol is implemented once; Windows and Android use different adapters for capabilities exposed by supported browsers, app APIs and the operating system. Do not assume that every app exposes remote control.

## Connection modes

- **attach_existing**: register an already-open session when the OS and app permit the local adapter to identify and control it.
- **managed**: open a real supported interface in a Backroom-managed environment, then register that session.

The group sees one registered session shape regardless of mode. A URL or MCP connection does not itself grant access to an authenticated provider session.

## Contract and safeguards

The **protocol.mjs** module validates explicit consent, platform/mode/capability allowlists, group/session scoping, strict action parameters, HTTPS-only navigation, trusted approval expiry and exact action binding, and result correlation.

Commands do not carry device credentials, provider cookies, passwords, or bearer tokens. Authentication is a separate trusted channel. The `trustedApproval` argument must come from the local host's protected approval store; an approval field embedded in an incoming command is rejected. These validators do not authenticate callers or execute actions. **Protocol v1 rejects `terminal.execute` even when approved**; the future contract uses an executable + argument list + working directory, not an arbitrary shell string, and a separately reviewed sandboxed executor is required before enabling terminal control. Task cancellation must name the exact target request.

## Tests

```sh
node --test integrations/backroom/protocol.node-test.mjs
```

The tests cover Windows/Android registrations, consent, protocol versions, capability restrictions, group/session isolation, approval expiry/scope, unsafe URLs, malformed payloads, forged approval fields, exact approval/request identity, terminal blocking, and result correlation.

## Platform constraints

Windows can use Microsoft UI Automation for controls that expose supported automation patterns, but some interactions require an unlocked, interactive desktop ([Microsoft reference](https://learn.microsoft.com/en-us/windows/win32/winauto/entry-uiauto-win32)).

Android should prefer app-specific APIs, intents and supported managed web sessions. Do not build the product around general-purpose autonomous `AccessibilityService` control: [Google Play policy restricts Accessibility API use for autonomous action planning/execution](https://support.google.com/googleplay/android-developer/answer/10964491) except qualifying accessibility tools. Any accessibility-based design requires separate platform/policy review. Android background tasks can be suspended or restricted; see [Android background-start restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start). Unsupported operations must report a visible limitation.

## Not yet implemented by this slice

This is the shared contract and validation suite—not yet an installable Windows companion, Android APK, browser/app driver, local IPC service, durable offline queue, or command executor. Those must be added behind the contract and tested against real devices. This local-first stage requires no always-on paid cloud worker.

## Minimal order of implementation

1. Preserve and verify the group/invitation/MCP read-send-read-back flow.
2. Implement a Windows local host with authenticated loopback IPC and managed browser support.
3. Implement Android-specific adapters with explicit OS permissions; unsupported cross-app control must fail visibly.
4. Add a durable, approval-aware offline action queue; enable terminal actions only after workspace scoping, approval, cancellation, output bounds, and audit records exist.
5. Add cloud execution only after revenue and measured cost limits justify it.
