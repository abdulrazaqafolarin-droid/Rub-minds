# Backroom native canonical wake driver contract

Status: **Android device-queue receiver and Accessibility/IME driver are present in source; the trusted host lease-forwarder and Windows native driver remain unconnected.**

This document defines the boundary between the existing group coordination/durable wake system and a future Android or Windows native composer driver. It does not enable native Off / On / Auto, native Send or a new host-server route.

## Why a separate native adapter exists

The managed-browser wake path already knows how to submit the canonical `@RMconnects` event prompt. Android now has a distinct `native_wake_trigger` action on the existing device-bearer-authenticated command poll/ACK channel. Its queue consumer validates the device, room, active screen session, app package, APK signer, canonical prompt and handoff expiry before checking the local grant and calling the internal Accessibility/IME submission routine. This is separate from the WebRTC `remote_text` draft channel. The missing upstream link is the trusted host-side forwarder that takes a claimed group wake lease and enqueues the scoped Android device command. Windows still has read-only UIA Send discovery/revalidation and no native canonical-wake driver.

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

The receiver-side state machine deduplicates handoffs per job and one-way lease-token digest. A preflight denial is retryable only when the composer was untouched and Send was not invoked, and only a new lease token may be accepted. A confirmed submission requires prompt readback, unchanged composer/Send identity digests, Send invocation and composer-clear confirmation. Android carries the 20-second handoff deadline into its local execution request and rechecks it before the seal, after the seal before IME insertion, and immediately before native Send. Any other post-handoff result is terminal `needs_review`, never an automatic replay. Receiver state is bounded and fails closed at capacity.

This is a tested **handoff contract plus an Android-side device consumer**, not an end-to-end group wake connection. The Android companion already polls `android/commands` with its device bearer, strictly maps `native_wake_trigger`, validates the paired device/room/screen session/app/signer/handoff, checks local consent, calls its internal native driver, and posts structured evidence to `android/ack`. The missing upstream component is the trusted host-side forwarder that validates the original group wake lease and creates the matching device command, then reconciles the device ACK to the host wake worker. Windows has no native queue consumer or canonical Send driver. This module does not authenticate the host's original durable lease, grant local consent or invoke OS Send itself. Keep native Send and native Off / On / Auto unavailable until the host forwarder and reconciliation are connected and physical acceptance passes.

## Android local wake-consent foundation — 2026-11-03

The Android companion now has a separate `NativeWakeConsentPolicy` and `AndroidNativeWakeConsentStore`. A user can explicitly pre-authorize native @RMconnects wake for one selected app on one paired device. The local grant is bound to the device UUID, app package and APK signing-certificate digest, expires after at most 24 hours, and is independently revocable. It does not reuse the app-launch, remote-touch or draft-typing grant.

Before a future native Send driver may act, the Android store also requires a synchronous `commit()` of a one-shot execution reservation bound to the group event ID, current screen session, app signer, composer identity digest, Send identity digest and target revision. An event is permanently non-replayable during the grant window even if the selected target changes after an uncertain attempt. The local policy enforces at most six reservations per rolling minute, a bounded 4,096-entry replay ledger and fail-closed handling for malformed or future-dated ledger entries. Device credential revocation removes the device's grant records and local replay ledger.

The companion's app-list UI includes a distinct checkbox and a system confirmation dialog explaining exactly what this permission covers. The UI states that **the trusted host forwarder and group-triggered native Auto are not connected in this build**. Saving the grant does not send anything. Android's existing device command poller now has a separate `native_wake_trigger` dispatcher; this is not exposed through the WebRTC `remote_text` handler. The dispatcher validates the scoped handoff, finds the local device/app/signer grant, and calls `submitCanonicalWake`. That routine checks the selected composer, uses the fixed event prompt only, persists the one-shot seal before insertion, rechecks the composer and unique Send control from the same final accessibility snapshot, invokes only that node, and waits for the same composer to clear. An ambiguous post-seal outcome is terminal `needs_review`. This is source code only; no Kotlin build or physical Send has been verified.

Verification inventory: `NativeWakeConsentPolicyTest` has 17 consent/journal cases, `AndroidNativeWakeHandoffPolicyTest` has 12 handoff-policy cases, `AndroidSendControlPolicyTest` has 8 Send-control cases, `NativeWakeBindingPolicyTest` has 2 generation-binding cases and `ProviderConversationIdentityPolicyTest` has 3 provider-conversation cases (42 Android JUnit cases total). The native driver captures the local binding generation and provider-conversation digest at selection/dispatch, then requires the same generation, app, composer, Send control and conversation identity before insertion, immediately before click and during composer-clear verification. The Android native-wake source-boundary suite has 16 Node tests, the Edge protocol suite has 13 Node tests, the Android Edge endpoint suite has 30 Node tests and the durable native-handoff suite has 13 Node tests. The device policy measures the 20-second handoff TTL from its validated issue time and allows at most three seconds of future clock skew while requiring a live expiry within the local grant deadline. Consent/grant mutations and one-shot reservations share one process-wide store lock. Old unscoped replay rows remain readable only to preserve replay protection; every new execution requires a valid provider-conversation digest. No provider adapter is registered yet, so no AI app can currently satisfy the native conversation gate. These tests are present in source but have not executed on the latest PR head. Latest GitHub Actions attempts failed before exposing runner steps or logs; do not treat that as a source failure or a successful build. APK compilation and physical-device acceptance remain unverified.


### Android composer-readback boundary — 2026-11-03

The Android native-wake driver performs narrowly scoped **local-only** reads of the currently selected composer value. It checks that the field is empty before the one-shot seal, that it contains exactly the canonical event prompt after IME insertion, and that the same composer clears after the Send action. These reads stay inside the phone's Accessibility/IME processes; no editor text, accessibility tree, group-message body or conversation history is sent to Rub Minds. This is a different permission and operation from ordinary `remote_text`, which remains draft insertion only and does not read or submit the field. The UI and acceptance text must describe this limited local readback accurately.

## Current implementation boundary

- Implemented in source: strict Android `native_wake_trigger` command mapping on the existing device-bearer queue, Android handoff validation, local app/signer consent lookup, persistent execution sealing, canonical IME insertion, same-snapshot Send revalidation/invocation, composer-clear confirmation and a structured device ACK.
- Implemented in source: Edge ACK validation against the persisted command/handoff scope, bounded `result_payload` receipt persistence, idempotent duplicate ACK handling and room-scoped outcome-only Realtime broadcast. Composer/Send digests remain in the service-role receipt and are not broadcast.
- Hardened: replay of an already reserved event/job/lease is terminal `needs_review`, never a retryable preflight denial. Uncertain post-seal results cannot claim successful read-back/revalidation evidence. The Edge result contract also rejects an impossible `needs_review` receipt that claims Send was invoked while the canonical prompt was never inserted.
- Still missing: trusted host-side forwarder that takes the claimed group wake lease and creates the matching device command; reconciliation of the device ACK/result back to the group wake worker; Windows UIA canonical wake driver and its separate local grant/seal; native Off / On / Auto activation; physical device tests.
- The existing Android `remote_text` data-channel message remains draft insertion only and is not an authenticated durable-wake lease. It must not be extended to click Send.
- The existing Android device poller is the native command consumer; however, no host group-wake producer currently enqueues a `native_wake_trigger` command. Thus group coordination cannot currently initiate Android native Send.
- The host-server bootstrap, its remote routes and production backend remain unchanged and deferred.

Do not enable native On or Auto until the trusted host forwarder and result reconciliation, Android queue/driver path, Windows native driver, separate local consent, durable no-replay behavior and physical acceptance are complete.


## Windows UI Automation Send-driver boundary — 2026-11-03

The Windows companion currently implements **read-only** Send discovery and recheck:

- `select_draft_target` stores the full `SendControlIdentity` (process ID, runtime ID, class, accessible name, AutomationId and bounds) in native Rust state; it serializes only the generated selection ID plus an availability flag/reason to the WebView.
- `recheck_draft_send_control` requires the same session and selection ID, revalidates the empty composer and foreground app, and compares the exact Send identity. It explicitly does not call UIA Invoke or a mouse click.
- The current generic draft-approval path consumes the selection and writes text only. It never presses Enter, invokes Send or retries an uncertain write.

The pinned `uiautomation = 0.25.1` crate exposes an `actions::Invoke` trait implemented for `ButtonControl`, and a `UIInvokePattern::invoke()` method. This is the appropriate native UI Automation primitive for a future button action; Microsoft describes Invoke as activating the control's single unambiguous action. References: [uiautomation 0.25.1 Invoke trait](https://docs.rs/uiautomation/0.25.1/uiautomation/actions/trait.Invoke.html), [UIInvokePattern](https://docs.rs/uiautomation/0.25.1/uiautomation/patterns/struct.UIInvokePattern.html), and [Microsoft UI Automation Invoke](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomationinvokepattern-invoke).

A future Windows driver must not simply call Invoke on the previously cached identity. It must, after a durable one-shot seal, obtain a fresh UIA snapshot and prove all of the following within that operation: the selected Backroom-launched foreground window is unchanged; the same composer identity now contains exactly the canonical event prompt; exactly one nearby visible/enabled Send button remains; the fresh button's complete identity equals the drag-time identity; and the same resolved button supports Invoke. It must then invoke that exact button, read the same composer locally until it clears or times out, and return explicit structured evidence. The complete UIA identity and composer text remain native-local.

Still required before implementing/enabling this action: a Windows-native 24-hour app/signer/target-scoped consent grant; a persistent one-shot event/job/lease journal with concurrency and crash/no-replay semantics; an authenticated device-bound handoff from the trusted group-wake producer; a bounded ACK/result path back to group coordination; and physical Windows acceptance. A WebView caller must never be able to supply an arbitrary prompt or bypass the signed handoff/local-consent checks through direct Tauri IPC. Until those exist, Windows Send recheck remains read-only and Windows native Off / On / Auto remains unavailable.


## Provider conversation identity is a separate native-send gate — 2026-11-03

The current Android handoff binds a durable lease to the Rub Minds AI/MCP sessionId, a native target ID/revision, app package and signer, screen-capture session, composer digest and Send-control digest. These identities are necessary but **do not prove which provider chat/thread is currently open inside the selected app**. screenSessionId identifies the companion's MediaProjection stream, not a ChatGPT/Claude conversation. The same app can reuse one composer node and one Send button across multiple chats; their hashes can remain unchanged after the user switches conversations.

Consequently, an app-level signer grant plus the current composer/Send checks cannot yet guarantee that a native trigger reaches the original AI conversation whose context and MCP session are registered with the Rub Minds group. This is a separate blocker from the missing trusted group-to-device forwarder.

Before native-app On / Auto or any native wake producer is enabled, the target contract must include a **provider-conversation identity digest** that is generated locally by an app-specific resolver and bound to the registered target revision and Rub Minds AI/MCP session. The companion must re-resolve and compare the same conversation identity when binding the target, before trigger insertion, immediately before Send and while confirming the result. Raw provider conversation IDs, titles, chat histories and message text must remain on-device; only the scoped digest/boolean result is allowed to leave the phone. If a provider does not expose a stable identity that can distinguish conversation A from conversation B, that provider remains draft-only for autonomous participation. A composer hash or app signer must never be used as a substitute for conversation identity.

Required acceptance cases: select conversation A, switch to B while the app reuses the same composer and Send controls, then deliver an old A handoff; the driver must reject before insertion or Send. Repeat with navigation during the post-insert/pre-Send window and during clear verification. A provider with no stable conversation resolver must remain unavailable even when composer and Send discovery succeed. The Android consent UI and Backroom capability panel now state this limitation explicitly.
