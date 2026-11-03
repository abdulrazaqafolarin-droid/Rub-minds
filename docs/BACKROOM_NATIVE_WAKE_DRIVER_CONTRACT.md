# Backroom native canonical wake driver contract

Status: **shared contract and tests added; no native platform driver is wired yet.**

This document defines the boundary between the existing group coordination/durable wake system and a future Android or Windows native composer driver. It does not enable native Off / On / Auto, native Send or a new host-server route.

## Why a separate native adapter exists

The managed-browser wake path already knows how to submit the canonical `@RMconnects` event prompt. The native Windows and Android frames currently discover and revalidate composer and Send-control identities, but their execution path is still draft-only.

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

## Current implementation boundary

- Implemented: shared `NativeCanonicalWakeAdapter`, fail-closed `LocalExecutionGuard` seal requirement for native wake, and Node policy/regression tests.
- Not implemented: Android accessibility/IME driver for canonical prompt insertion and Send invocation; Windows UIA driver for canonical prompt insertion and Send invocation; device-bound durable queue consumer; native wake-grant UI/lifecycle; physical device tests.
- The existing Android `remote_text` data-channel message is still a general draft-insertion path and is not an authenticated durable-wake lease. It must not be extended to click Send.
- The existing Windows and Android Send-control discovery/recheck operations remain read-only. No native Send action is exposed by this contract alone.
- The host-server bootstrap, its remote routes and production backend remain unchanged and deferred.

Do not enable native On or Auto until both platform drivers, the device-bound lease consumer, separate local consent, durable no-replay behavior and physical acceptance are complete.
