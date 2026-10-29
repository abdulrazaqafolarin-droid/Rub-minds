# Rub Minds Backroom — shared protocol v1

Backroom is the local control layer behind a Rub Minds group. The protocol is implemented once; Windows and Android use different adapters for capabilities exposed by supported browsers, app APIs and the operating system. Do not assume that every app exposes remote control.

## Connection modes

- **attach_existing**: register an already-open session when the OS and app permit the local adapter to identify and control it.
- **managed**: open a real supported interface in a Backroom-managed environment, then register that session.

The group sees one registered session shape regardless of mode. A URL or MCP connection does not itself grant access to an authenticated provider session.

## Contract and safeguards

The **protocol.mjs** module validates explicit consent, platform/mode/capability allowlists, group/session scoping, strict action parameters, HTTPS-only navigation, trusted approval expiry and exact action binding, and result correlation.

Commands do not carry device credentials, provider cookies, passwords, or bearer tokens. Authentication is a separate trusted channel. The `trustedApproval` argument must come from the local host's protected approval store; an approval field embedded in an incoming command is rejected. These validators do not authenticate callers or execute actions. **Protocol v1 rejects `terminal.execute` even when approved**; the future contract uses an executable + argument list + working directory, not an arbitrary shell string, and a separately reviewed sandboxed executor is required before enabling terminal control. Task cancellation must name the exact target request.

## Local offline queue engine

`offline-queue.mjs` is a storage-agnostic, single-host queue engine for only two explicitly supported operations: approved external conversation messages and HTTPS navigation. It:
- enforces queue and payload size limits, FIFO batches and request-ID deduplication;
- stores an opaque approval reference, not the approval payload or bearer secret;
- keeps actions queued while offline and expires old actions;
- rechecks the currently registered session, permissions and trusted approval before replay;
- bounds retries, validates correlated executor results, supports pending cancellation and recovers interrupted work with an explicit at-least-once warning.

**It is not yet a durable device queue.** The platform host must supply durable local storage with OS-appropriate protection and ensure there is only one active drainer per store. An interrupted action may have reached its target before the host crashed; the adapter must enforce the idempotency key to prevent duplicate side effects. Never replay an expired/revoked approval. Raw command content is stored locally, so the eventual storage adapter must protect sensitive content and not sync it to the group by default.

Terminal execution is deliberately not queueable and is rejected by protocol v1 until a separately reviewed sandboxed executor exists.

## Tests

Run the complete Backroom contract and queue suite:

```sh
npm run test:backroom
```

Or run the focused files directly:

```sh
node --test integrations/backroom/protocol.node-test.mjs integrations/backroom/offline-queue.node-test.mjs
```

The tests cover cross-platform registration, consent and capability isolation, stale/forged approvals, unsafe URLs, action/result correlation, terminal blocking, queue bounds, offline behavior, expiry, fresh approval lookup, revoked capability handling, FIFO batches, retries, cancellation, at-least-once recovery and deduplication.

## Platform constraints

Windows can use Microsoft UI Automation for controls that expose supported automation patterns, but some interactions require an unlocked, interactive desktop ([Microsoft reference](https://learn.microsoft.com/en-us/windows/win32/winauto/entry-uiauto-win32)).

Android should prefer app-specific APIs, intents and supported managed web sessions. Do not build the product around general-purpose autonomous `AccessibilityService` control: [Google Play policy restricts Accessibility API use for autonomous action planning/execution](https://support.google.com/googleplay/android-developer/answer/10964491) except qualifying accessibility tools. Any accessibility-based design requires separate platform/policy review. Android background tasks can be suspended or restricted; see [Android background-start restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start). Unsupported operations must report a visible limitation.

## Not yet implemented by this slice

This is a shared contract plus queue engine—not yet an installable Windows companion, Android APK, browser/app driver, local IPC service, OS-backed durable storage adapter, or command executor. Those must be added behind the contract and tested against real devices. This local-first stage requires no always-on paid cloud worker.

## Minimal order of implementation

1. Preserve and verify the group/invitation/MCP read-send-read-back flow.
2. Implement a Windows local host with authenticated loopback IPC and managed browser support.
3. Implement Android-specific adapters with explicit OS permissions; unsupported cross-app control must fail visibly.
4. Add OS-protected durable queue storage, audit and reconnect acceptance tests. Keep terminal actions disabled until workspace scoping, approval, cancellation, output bounds and sandbox tests exist.
5. Add cloud execution only after revenue and measured cost limits justify it.
