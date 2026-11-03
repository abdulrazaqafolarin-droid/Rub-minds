# Backroom native canonical wake driver contract

Status: **shared contract and tests added; no native platform driver is wired yet.**

This document defines the boundary between the existing group coordination/durable wake system and a future Android or Windows native composer driver. It does not enable native Off / On / Auto, native Send or a new host-server route.

## Why a separate native adapter exists

The managed-browser wake path already knows how to submit the canonical `@RMconnects` event prompt. Android now has a source-level internal submission routine that inserts the canonical event prompt through the Rub Minds IME and invokes the same-snapshot revalidated Send node after the local grant and one-shot seal. Windows still has read-only UIA Send discovery/revalidation. The Android routine is not connected to a device-authenticated durable queue consumer or any WebRTC command.

The native wake adapter must not reuse the generic draft adapter. A draft is ordinary text insertion under a one-shot typing approval. A wake is a special event-bound operation that may invoke exactly one verified Send control after a separate device-scoped local permission and persistent execution seal.

## Trusted execution sequence

1. The existing group coordinator creates a durable job for one eligible AI binding. The job contains the event reference and the exact canonical prompt; it never carries the originating group-message body.
2. A trusted paired worker validates the claimed lease, group/participant/session/binding/host/target scope and current wake grant.
3. `LocalExecutionGuard` checks device connectivity, the separate native wake permission, foreground app identity and current composer/Send readiness.
4. On native surfaces, `beforeEffect` is mandatory. It must reserve the persistent one-time execution journal and consume the exact one-shot local wake grant. A native wake is rejected when that callback is absent or returns false.
5. Only after the seal does the platform driver repeat the exact composer and Send-control checks. It verifies the composer is empty, inserts the fixed event prompt, reads the exact prompt back, re-identifies the same Send control, invokes that control and waits for the same composer to clear.
6. The queue may acknowledge a completed trigger only when the driver returns explicit evidence for the event UUID and composer-clear confirmation. Any uncertain or partial outcome becomes `needs_review`; the job must not be blindly replayed.
7. The awakened AI independently retrieves the group event through its joined Rub Minds MCP session and sends its actual group response through `send_group_message`. Trigger acknowledgement is not group-response acknowledgement.

## Adapter contract

`NativeCanonicalWakeAdapter` supports only `android_app`, `windows_app` and `desktop_app` targets with an `accessibility` locator. Its constructor pins the group, host, space, target ID/revision, app, session and foreground identity. A target revision or scope change requires a fresh registration.

The preflight returns opaque SHA-256 digests for the selected composer identity and Send-control identity, along with the exact target ID/revision. The adapter requires those digests to be echoed unchanged after the post-seal recheck. A driver cannot satisfy the contract by returning generic `true` flags for a replacement field or button.

The platform driver implements:

- `inspectWakeTarget({ target })`: returns only bounded booleans and app/session identity. It must attest a connected, focused target; an empty composer whose exact identity still matches; and exactly one visible, enabled, nearby Send control whose identity still matches. Full node/UIA identities remain native-local.
- `submitCanonicalWake({ target, eventId, jobId, prompt, ...requirements })`: rechecks all identities after the durable seal; accepts only the fixed prompt created from `eventId`; verifies exact insertion; invokes only the same Send node; waits for composer clear; and never retries. It returns explicit flags for prompt insertion/readback, composer and Send identity revalidation, Send invocation and composer clear.
- Any failure after the seal must return a bounded uncertain result or throw. The adapter converts that outcome to `needs_review`, never an automatic retry.

The adapter itself rejects caller-authored text, a prompt whose event UUID does not match, a stale target revision, a non-native surface, a generic draft operation, missing local execution-seal proof, or a second attempt for the same job within the adapter lifetime.

## Privacy and permission boundary

The full composer identity, Send-control identity, accessibility labels, editor text and provider conversation content remain inside the native process. The driver receives the event ID and canonical prompt only. No group-message body is injected into the AI provider composer.

The native wake grant is distinct from app selection, remote touch, general draft typing and the browser wake grant. The device must retain the exact local approval and revoke it on expiry, app/session change, device stop or explicit Off. The durable journal is also separate from the group response's MCP pending-response state.


## Separate native local authorization

`NativeWakeAuthorizationAuthority` now provides a process-local grant that is independent from the browser `WakeAuthorizationAuthority`, remote touch, and general draft-typing permission. Its scope includes the native device/host, group, AI participant, exact MCP session, binding, app identity, selected target ID and target revision. It requires an explicit local-confirmation signal from the trusted native UI, expires within the bounded consent window, enforces its own six-per-minute limit and consumes each stable event command once.

The future native worker checks this grant non-consumingly as part of `LocalExecutionGuard.permission`. Its `beforeEffect` callback uses `reserveNativeWakeExecution` to reserve the durable `FileWakeExecutionJournal` seal first and then consume the exact native grant. A duplicate seal or invalid/expired grant blocks Send. If grant consumption fails after reservation, the seal remains; the job is not replayed. This helper is source-level only: no Android/Windows local approval screen or device-bound wake consumer is wired yet.


## Durable dispatch integration verification — 2026-11-03

The adapter has now been exercised through the real source-level `dispatchClaimedWake` path with a registered `TargetRegistry`, `BackroomDispatcher`, `LocalExecutionGuard` and a claimed event lease. The integration test verifies:

- The wake grant is checked before local inspection; device connectivity/permission and the live foreground composer/Send preflight occur before sealing.
- The durable one-time seal is reserved before the one-shot grant is consumed, and both happen before the native adapter is called.
- A failed focus/composer preflight returns the lease to the retry path without sealing or consuming the grant.
- A Send with no confirmed composer-clear result, or a native channel failure after sealing, is acknowledged as ignored/needs-review and is not retried.
- Only the canonical event-bound prompt is passed to the platform driver; the original group-message body is not passed through the native adapter.

The focused combined Node 22.16.0 sandbox run of the shared guard, adapter policy, native authorization, durable-dispatch integration and native handoff tests passed **49/49**. The isolated handoff suite also passed **12/12**. These tests did not load an actual Android Accessibility/IME or Windows UIA driver.

## Device-bound handoff contract — 2026-11-03

A separate `native_wake_trigger` envelope now defines the short-lived handoff from a trusted durable-queue worker to a selected native companion. It is deliberately distinct from Android `remote_text` (draft insertion) and from screen-stream control messages. The envelope includes the one durable job/event/lease, paired device ID, room, exact active screen-session ID, binding, AI MCP session, target ID/revision, app identity, previously inspected composer/Send identity digests, canonical fixed prompt and bounded expiry. The original durable queue lease token never leaves the trusted worker; the envelope carries only its SHA-256 digest for replay deduplication. It rejects additional fields—including group-message bodies and generated AI response text.

The receiver-side state machine deduplicates handoffs per job and one-way lease-token digest. A preflight denial is retryable only when the composer was untouched and Send was not invoked, and only a new lease token may be accepted. A confirmed submission requires prompt readback, unchanged composer/Send identity digests, Send invocation and composer-clear confirmation. Any other post-handoff result is terminal `needs_review`, never an automatic replay. Receiver state is bounded and fails closed at capacity.

This is a tested **handoff contract**, not yet a connected device queue. The trusted host worker still needs a server-mediated forwarder that validates its original durable lease and creates a queue item for the paired device. The companion must poll that queue with its device credential, validate the exact active screen session and target, and then call this receiver. Android/Windows native consumers are not wired yet. This module does not authenticate Realtime/WebRTC origins, claim durable leases, grant local consent or invoke OS Send. Keep native Send and native Off / On / Auto unavailable until those integrations are complete.

## Android local wake-consent foundation — 2026-11-03

The Android companion now has a separate `NativeWakeConsentPolicy` and `AndroidNativeWakeConsentStore`. A user can explicitly pre-authorize native @RMconnects wake for one selected app on one paired device. The local grant is bound to the device UUID, app package and APK signing-certificate digest, expires after at most 24 hours, and is independently revocable. It does not reuse the app-launch, remote-touch or draft-typing grant.

Before a future native Send driver may act, the Android store also requires a synchronous `commit()` of a one-shot execution reservation bound to the group event ID, current screen session, app signer, composer identity digest, Send identity digest and target revision. An event is permanently non-replayable during the grant window even if the selected target changes after an uncertain attempt. The local policy enforces at most six reservations per rolling minute, a bounded 4,096-entry replay ledger and fail-closed handling for malformed or future-dated ledger entries. Device credential revocation removes the device's grant records and local replay ledger.

The companion's app-list UI includes a distinct checkbox and a system confirmation dialog explaining exactly what this permission covers. The UI states that **native wake delivery and automatic Send are not connected in this build**. Saving the grant does not send anything. Android now contains an internal `submitCanonicalWake` routine; it is not exposed through the existing WebRTC `remote_text` handler, and there is no authenticated device queue caller. The routine checks the selected composer, uses the fixed event prompt only, persists the one-shot seal before insertion, rechecks the composer and unique Send control from the same final accessibility snapshot, invokes only that node, and treats uncertain post-seal results as `needs_review`. It waits for the same composer to clear. This is source code only; no Kotlin build or physical Send has been verified.

Verification status: thirteen Android native-wake consent/journal JUnit cases are present in `NativeWakeConsentPolicyTest`; the separate `AndroidSendControlPolicyTest` contributes eight Send-control policy cases (21 Android native-wake/Send policy cases total). Neither JUnit suite has executed on this PR head: the GitHub Android and validation jobs failed before runner allocation (`runner_id=0`, zero steps), and the available isolated Node sandbox has no Java/Kotlin/Gradle toolchain. The seven-test Node source-boundary suite passed in an isolated Node 22 run, but that is not a Kotlin compile or device test. Do not mark the Android build or physical-device acceptance as passed until a real Android runner executes the Gradle unit-test and assemble tasks.


### Android composer-readback boundary — 2026-11-03

The Android native-wake driver performs narrowly scoped **local-only** reads of the currently selected composer value. It checks that the field is empty before the one-shot seal, that it contains exactly the canonical event prompt after IME insertion, and that the same composer clears after the Send action. These reads stay inside the phone's Accessibility/IME processes; no editor text, accessibility tree, group-message body or conversation history is sent to Rub Minds. This is a different permission and operation from ordinary `remote_text`, which remains draft insertion only and does not read or submit the field. The UI and acceptance text must describe this limited local readback accurately.

## Current implementation boundary

- Implemented: shared `NativeCanonicalWakeAdapter`, fail-closed `LocalExecutionGuard` seal requirement for native wake, process-local native grant/seal helper, strict device handoff/result schema and bounded replay-aware receiver policy; 49 focused Node regressions pass.
- Implemented in source, not connected: Android accessibility/IME routine for canonical prompt insertion, same-snapshot Send invocation and composer-clear confirmation; Android local 24-hour wake consent and one-shot replay journal.
- Not implemented: device-authenticated durable queue consumer/forwarder; Windows UIA canonical wake driver and separate local grant/seal; native Off / On / Auto activation; physical device tests.
- The existing Android `remote_text` data-channel message is still a general draft-insertion path and is not an authenticated durable-wake lease. It must not be extended to click Send.
- Windows Send-control discovery/recheck remains read-only. Android's new Send routine is internal source only; no route or queue calls it yet.
- The host-server bootstrap, its remote routes and production backend remain unchanged and deferred.

Do not enable native On or Auto until both platform drivers, the device-bound lease consumer, separate local consent, durable no-replay behavior and physical acceptance are complete.
