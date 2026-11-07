# Backroom native canonical wake driver contract

> For the upstream group-event, drag-select, binding and downstream MCP response lifecycle around this driver, see [Backroom group-to-composer wake flow](BACKROOM_GROUP_TO_COMPOSER_WAKE_FLOW.md).

Status (2026-11-07): **The source branch now includes the service-role Android group-lease forwarder, device-attested phone binding, attestation-bound ACK settlement and a durable phone ACK outbox. Local PostgreSQL and Node regressions pass, but the migrations/Edge changes are not deployed and no physical-device acceptance has run. The Android provider resolver registry is still empty, Windows has no native Send driver, and native Off / On / Auto remain disabled.**

This document defines the boundary between the existing group coordination/durable wake system and a future Android or Windows native composer driver. It does not enable native Off / On / Auto, native Send or a new host-server route.

## Why a separate native adapter exists

The managed-browser wake path already knows how to submit the canonical `@RMconnects` event prompt. Android has a distinct `native_wake_trigger` action on the existing device-bearer-authenticated command poll/ACK channel. The queue consumer validates device, room, active screen session, app package, APK signer, canonical prompt and handoff expiry before checking local consent and invoking the Accessibility/IME submission routine; this remains separate from WebRTC `remote_text` draft insertion. The device-attested mapping from a group AI/MCP binding to a paired Android screen/app is created through an owner challenge and device-bearer completion. The trusted host-side forwarder is now implemented in source: when the authenticated `backroom-wake` gateway claims an Android-surface lease, the service-role Edge function calls a private idempotent SQL RPC to enqueue the exact phone command and returns no lease to the generic host dispatcher. Phone ACKs are stored in a bounded local outbox and on the private device-command row before group settlement/Realtime delivery. A late or revoked result is retained as receipt evidence but is never reported as a late successful group ACK. Windows still has read-only UIA Send discovery/revalidation and no native canonical-wake driver.

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

The future native worker checks this grant non-consumingly as part of `LocalExecutionGuard.permission`. Its `beforeEffect` callback uses `reserveNativeWakeExecution` to reserve the durable `FileWakeExecutionJournal` seal first and then consume the exact native grant. A duplicate seal or invalid/expired grant blocks Send. If grant consumption fails after reservation, the seal remains; the job is not replayed. The Android local approval UI, device-bound wake consumer and service-role group-lease forwarder are present in source; Windows does not yet have its equivalent native grant/consumer path.


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

This is now a connected **source-level Android queue-to-device path**, not a deployed or physically accepted capability. The `backroom-wake` Edge claim path forwards an authenticated Android lease into the paired phone's private command queue through the service-role SQL function; the generic host dispatcher receives an empty lease list, not the raw lease token. The Android companion polls `android/commands`, validates the device/room/screen/app/signer/handoff, checks local consent, writes a PREPARED receipt before scheduling a native effect, and writes a FINAL receipt before sending the ACK. A failed HTTP ACK is replayed from the durable outbox on later polls; a PREPARED receipt after process death becomes `needs_review`, never a second Send. The Edge stores the exact result on the device-command row, then attempts the original group-lease settlement. If consent/attestation is revoked or the group lease has expired, the group job is cancelled/failed or reported as lease-mismatched; it is never marked successful late. The relevant migration and Edge changes remain undeployed, no physical phone acceptance has run, the provider resolver registry is empty, and Windows has no native queue consumer or canonical Send driver. Keep native Send and native Off / On / Auto unavailable until provider identity, deployment, physical acceptance and the Windows/native product boundary are resolved.

## Android local wake-consent foundation — 2026-11-03

The Android companion now has a separate `NativeWakeConsentPolicy` and `AndroidNativeWakeConsentStore`. A user can explicitly pre-authorize native @RMconnects wake for one selected app on one paired device. The local grant is bound to the device UUID, app package and APK signing-certificate digest, expires after at most 24 hours, and is independently revocable. It does not reuse the app-launch, remote-touch or draft-typing grant.

Before a future native Send driver may act, the Android store also requires a synchronous `commit()` of a one-shot execution reservation bound to the group event ID, current screen session, app signer, composer identity digest, Send identity digest and target revision. An event is permanently non-replayable during the grant window even if the selected target changes after an uncertain attempt. The local policy enforces at most six reservations per rolling minute, a bounded 4,096-entry replay ledger and fail-closed handling for malformed or future-dated ledger entries. Device credential revocation removes the device's grant records and local replay ledger.

The companion's app-list UI includes a distinct checkbox and a system confirmation dialog explaining exactly what this permission covers. The UI must state that the server-side forwarder now exists in source but is not deployed or accepted, and that saving local consent does not activate group-triggered native Auto. Saving the grant does not send anything. Android's existing device command poller now has a separate `native_wake_trigger` dispatcher; this is not exposed through the WebRTC `remote_text` handler. The dispatcher validates the scoped handoff, finds the local device/app/signer grant, and calls `submitCanonicalWake`. That routine checks the selected composer, uses the fixed event prompt only, persists the one-shot seal before insertion, rechecks the composer and unique Send control from the same final accessibility snapshot, invokes only that node, and waits for the same composer to clear. An ambiguous post-seal outcome is terminal `needs_review`. This is source code only; no Kotlin build or physical Send has been verified.

Current local verification (PR #66 source branch, 2026-11-07): the native-wake source-boundary suite passed **34/34**; `npm run test:companion` passed **140/140**; `npm run test:backroom` passed **126/126**; and the new pure Kotlin ACK-outbox policy compiled with Kotlin 2.0.21 and passed **4/4 JUnit tests**. The nine-migration PostgreSQL 18 sequence and `supabase/tests/backroom_wake_queue.sql` passed in a disposable local database. Both modified Edge Functions passed an esbuild syntax/bundle check. This is not a full Android Gradle/APK build: the sandbox lacked an Android SDK. The broader project build's prebuild hook could not complete because the saved partial sandbox workspace could not locate its MCP test inputs. Latest GitHub Actions attempts still fail without exposing runner steps or retrievable job logs, and Vercel's build check points to the free-plan build-rate limit. No production migration/deployment or physical-device acceptance has been performed. The Android provider resolver registry remains empty, so no AI app currently satisfies the native conversation gate.


### Android composer-readback boundary — 2026-11-03

The Android native-wake driver performs narrowly scoped **local-only** reads of the currently selected composer value. It checks that the field is empty before the one-shot seal, that it contains exactly the canonical event prompt after IME insertion, and that the same composer clears after the Send action. These reads stay inside the phone's Accessibility/IME processes; no editor text, accessibility tree, group-message body or conversation history is sent to Rub Minds. This is a different permission and operation from ordinary `remote_text`, which remains draft insertion only and does not read or submit the field. The UI and acceptance text must describe this limited local readback accurately.

## Current implementation boundary

- Implemented in source: strict Android `native_wake_trigger` command mapping on the existing device-bearer queue, Android handoff validation, local app/signer consent lookup, persistent execution sealing, canonical IME insertion, same-snapshot Send revalidation/invocation, composer-clear confirmation and a structured device ACK.
- Implemented in source: Edge ACK validation against the persisted command/handoff scope, bounded `result_payload` receipt persistence, idempotent duplicate ACK handling and room-scoped outcome-only Realtime broadcast. Composer/Send digests remain in the service-role receipt and are not broadcast.
- Hardened: replay of an already reserved event/job/lease is terminal `needs_review`, never a retryable preflight denial. Uncertain post-seal results cannot claim successful read-back/revalidation evidence. The Edge result contract also rejects an impossible `needs_review` receipt that claims Send was invoked while the canonical prompt was never inserted.
- Implemented in source: the trusted `backroom-wake` Edge claim path forwards Android-surface leases through a service-role RPC into the exact paired phone command queue. Raw group lease tokens are not returned to the generic host dispatcher.
- Implemented in source: a bounded phone-side ACK outbox persists PREPARED before native execution and FINAL after the result; ACK retry does not re-run Send. The Edge stores the exact device receipt before settlement and handles late/revoked outcomes without declaring late success.
- Still missing: a verified provider-conversation resolver for ChatGPT/Claude or other providers, Windows UIA canonical wake driver and its separate local grant/seal, deployment of the new database/Edge changes, and physical Android/Windows acceptance.
- The existing Android `remote_text` data-channel message remains draft insertion only and is not an authenticated durable-wake lease. It must not be extended to click Send.
- The Android group-to-device path is source-connected, but the provider resolver registry is empty; therefore no provider app currently satisfies the autonomous native conversation identity gate.
- The host-server bootstrap and broader remote routes remain unchanged and deferred.

Do not enable native Off / On / Auto until a verified provider resolver is available, migrations/Edge changes are deployed, the Android device path is physically accepted, and the Windows path is either implemented or deliberately excluded. Source tests do not substitute for those gates.


## Windows UI Automation Send-driver boundary — 2026-11-03

The Windows companion currently implements **read-only** Send discovery and recheck:

- `select_draft_target` stores the full `SendControlIdentity` (process ID, runtime ID, class, accessible name, AutomationId and bounds) in native Rust state; it serializes only the generated selection ID plus an availability flag/reason to the WebView.
- `recheck_draft_send_control` requires the same session and selection ID, revalidates the empty composer and foreground app, and compares the exact Send identity. It explicitly does not call UIA Invoke or a mouse click.
- The current generic draft-approval path consumes the selection and writes text only. It never presses Enter, invokes Send or retries an uncertain write.

The pinned `uiautomation = 0.25.1` crate exposes an `actions::Invoke` trait implemented for `ButtonControl`, and a `UIInvokePattern::invoke()` method. This is the appropriate native UI Automation primitive for a future button action; Microsoft describes Invoke as activating the control's single unambiguous action. References: [uiautomation 0.25.1 Invoke trait](https://docs.rs/uiautomation/0.25.1/uiautomation/actions/trait.Invoke.html), [UIInvokePattern](https://docs.rs/uiautomation/0.25.1/uiautomation/patterns/struct.UIInvokePattern.html), and [Microsoft UI Automation Invoke](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomationinvokepattern-invoke).

A future Windows driver must not simply call Invoke on the previously cached identity. It must, after a durable one-shot seal, obtain a fresh UIA snapshot and prove all of the following within that operation: the selected Backroom-launched foreground window is unchanged; the same composer identity now contains exactly the canonical event prompt; exactly one nearby visible/enabled Send button remains; the fresh button's complete identity equals the drag-time identity; and the same resolved button supports Invoke. It must then invoke that exact button, read the same composer locally until it clears or times out, and return explicit structured evidence. The complete UIA identity and composer text remain native-local.

Still required before implementing/enabling this action: a Windows-native 24-hour app/signer/target-scoped consent grant; a persistent one-shot event/job/lease journal with concurrency and crash/no-replay semantics; an authenticated device-bound handoff from the trusted group-wake producer; a bounded ACK/result path back to group coordination; and physical Windows acceptance. A WebView caller must never be able to supply an arbitrary prompt or bypass the signed handoff/local-consent checks through direct Tauri IPC. Until those exist, Windows Send recheck remains read-only and Windows native Off / On / Auto remains unavailable.


## Provider conversation identity is a separate native-send gate — 2026-11-03

The Android device handoff contract requires a provider-conversation identity digest in addition to the Rub Minds AI/MCP session ID, native target ID/revision, app package and signer, screen-capture session, composer digest and Send-control digest. `screenSessionId` identifies the companion's MediaProjection stream, not a ChatGPT/Claude conversation. The #66 source branch adds this digest to the input-binding and wake-job schema, copies it from the exact matching binding into the durable queue row, and returns it from a new service-role-only claim wrapper through the `backroom-wake` Edge mapper. The original claim RPC is unchanged. This migration and Edge change have not been applied/deployed, so the live database cannot yet issue these provider-aware leases. The same app can reuse one composer node and one Send button across multiple chats; their hashes can remain unchanged after the user switches conversations.

The Android composer-selection and Send-control acknowledgements expose only bounded availability/match status to the browser; they do not expose the provider digest or raw conversation ID. When the owner explicitly links a selected group AI, the phone re-reads the composer, Send-control, installed-app signer and provider-conversation digests locally, then sends those opaque digests directly to the device-bearer Edge completion route. The owner-authenticated challenge route and service-role RPC create the device-attested mapping without routing the digests through the browser. A later conversation switch invalidates the local identity check; a fresh attestation is required.

The new source contracts make the provider digest available to the paired host worker after the migrations are applied, and the phone-side binding RPC can pin that digest to an existing group AI. However, the Android provider identity resolver registry is still empty. The host-side group-lease-to-device-command forwarder is implemented in source but not deployed or physically accepted. Therefore ChatGPT, Claude and other providers still cannot currently prove a real active conversation identity for native group wake. An app-level signer grant plus composer/Send checks is not enough.

Before native-app On / Auto or any native wake producer is enabled, the target contract must include a **provider-conversation identity digest** that is generated locally by an app-specific resolver and bound to the registered target revision and Rub Minds AI/MCP session. The companion must re-resolve and compare the same conversation identity when binding the target, before trigger insertion, immediately before Send and while confirming the result. Raw provider conversation IDs, titles, chat histories and message text must remain on-device; only the scoped digest/boolean result is allowed to leave the phone. If a provider does not expose a stable identity that can distinguish conversation A from conversation B, that provider remains draft-only for autonomous participation. A composer hash or app signer must never be used as a substitute for conversation identity.

Required acceptance cases: select conversation A, switch to B while the app reuses the same composer and Send controls, then deliver an old A handoff; the driver must reject before insertion or Send. Repeat with navigation during the post-insert/pre-Send window and during clear verification. A provider with no stable conversation resolver must remain unavailable even when composer and Send discovery succeed. The Android consent UI and Backroom capability panel now state this limitation explicitly.


## Multi-attempt result receipt retention

The durable group job keeps a private, bounded receipt for each native handoff (at most five, matching the queue attempt limit). Exact delayed ACK replays remain idempotent after a safe preflight retry and a later attempt. Reusing a handoff ID with different result content is rejected. The latest result is also retained separately for current-state inspection.


## Device-attested group binding handshake — source update, 2026-11-06

The earlier “Still missing” note is superseded in one respect: the #66 source branch now contains the owner-authenticated native-binding challenge routes, the device-bearer completion route, the Android Accessibility evidence bridge and the database registration/revocation lifecycle. The browser relays a 90-second nonce and challenge ID only. Composer, Send-control, app-signer and provider-conversation identities are sent directly from the phone to the device-bearer Edge route and stored as opaque digests.

The RPC locks the existing MCP session and input binding before it locks the challenge and phone-side records, then locks and rechecks the live MCP credential/agent connection, screen, device, device-room grant, installed app signer and host lease. It requires a pre-existing owner-authorized Android group input binding and never enables wake as part of registration. The first provider digest can be added only if the phone mapping proves it; the digest is immutable afterward. Lifecycle triggers revoke mappings and pending challenges on screen stop/expiry, device revocation, room unpair, app identity/signer change or removal, host revocation/expiry, and group binding revocation. Shortening a screen or host lease caps dependent proofs immediately; extending a lease does not silently renew an existing attestation.

This is **not yet a usable native autonomous execution path**: the provider resolver registry is still empty (including ChatGPT and Claude), the phone frame depends on an existing owner-authorized group input binding, and the new forwarding/settlement migrations and Edge changes are source-only. The trusted host forwarder now exists in source. Native Android/Windows Off / On / Auto remain unavailable pending deployment, verified provider identity and physical-device acceptance.
