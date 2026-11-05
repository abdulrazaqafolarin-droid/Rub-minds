# Backroom interaction modes

> The end-to-end relationship between group events, selected composers, draft insertion, wake authorization and native device delivery is mapped in [Backroom group-to-composer wake flow](BACKROOM_GROUP_TO_COMPOSER_WAKE_FLOW.md).

## Scope

The first Off / On / Auto control is supported only by a live, registered managed-browser composer whose local host reports canonical wake capability. It is not a general-purpose automatic typing switch for native Windows apps, Android apps, terminals, or arbitrary desktop windows. Those surfaces retain their separate manual draft and local-approval flows.

## Native app-frame capability boundary — 2026-11-03

The Windows desktop frame and Android Phone Frame have source-level drag-select composer targeting and local discovery/revalidation of one nearby Send control. Windows keeps full UI Automation identity in native Rust memory; Android keeps accessibility-node identity on the phone. Both expose only bounded discovery/recheck status to the Backroom frame. Android also has a separate `native_wake_trigger` command on its device-bearer-authenticated queue poll/ACK channel. The companion validates the exact handoff and invokes the internal native-wake routine only after local consent and a persistent event seal. It is not reachable from the existing WebRTC draft channel.

This is not yet the native Off / On / Auto execution path. Android's device queue consumer and internal Send routine are present in source, but the trusted host forwarder that converts an eligible group wake lease into a device command is not connected. Therefore the group coordinator cannot currently initiate an autonomous phone send. Windows remains read-only for Send. The Android local wake grant and persistent one-shot event seal are separate from app-launch, touch and draft-typing permission. Physical Android Send and Windows Send remain unaccepted.

## Native canonical-wake adapter contract — 2026-11-03

A shared `NativeCanonicalWakeAdapter` interface and Node regression tests now define how an already-authorized durable event wake can be executed by a future Android or Windows accessibility driver. The interface binds one native target revision and requires the exact empty composer plus one unique, visible, enabled and identity-verified Send control. It accepts only the canonical event-bound `@RMconnects` prompt, requires proof that the durable one-time execution seal and one-shot local grant were acquired, and reports success only after the same composer clears.

This is a **partially implemented source path, not an enabled device capability**. Android has a separate local approval screen, 24-hour app/signer-bound grant, persistent one-shot event seal, canonical-prompt IME insertion, same-snapshot Send driver and a distinct device-queue command/ACK path. The missing connection is now specifically the device-attested group-binding handshake and trusted host-side forwarder from the group's durable wake lease to that device queue. The device ACK settlement path is present in source: `android/ack` validates the device-bound structured result and calls the service-role `settle_backroom_android_native_wake_result` routine against the original group lease before committing the Android command ACK. The settlement routine handles submitted, safe preflight-denied retry and terminal `needs_review` outcomes. It is not reachable from a real group event until the binding handshake and forwarder exist. Windows has no native Send driver. The Android WebRTC `remote_text` channel remains draft-only and must not be used to transport durable wake jobs or invoke Send. Native Off / On / Auto, host-server composition, production backend changes and physical acceptance remain unavailable/deferred.

### Native wake contract verification — 2026-11-03

The native adapter compares opaque SHA-256 composer and Send-control identity digests captured during preflight with the digests returned after the post-seal recheck. The native handoff and Android device protocol also require a separate provider-conversation digest. The Android device consumer validates the paired device, room, active screen session, app/signer, canonical prompt and bounded expiry before local consent and the one-shot journal can authorize the native Send driver. The raw durable group-queue lease token stays on the trusted worker; only its digest crosses the device handoff.

The #66 source branch adds the provider-conversation digest to the group input-binding and wake-job schemas, copies it from the exact matching binding at queue insertion, and exposes it through a new service-role-only `claim_backroom_wake_jobs_with_provider_identity` wrapper. The `backroom-wake` Edge mapper now returns that field in the claimed lease, and the host remote-lease/paired-worker path preserves the lease object. The original claim RPC remains unchanged for compatibility. These are source changes only: the new migration has not been applied to staging or production, and the new Edge function has not been deployed.

That source contract does **not** yet register the real Android frame. The phone currently returns only `providerConversationIdentityAvailable: boolean` to the browser; the digest intentionally remains on the phone. `BackroomAndroidControl` has only device/room context and no selected AI participant/MCP session or device-attested binding request. The generic owner-authenticated binding endpoint does not bind the phone's current device/screen/app/composer/Send state. A separate device-bearer-authenticated enrollment handshake is required before the digest can safely enter the database or a claimed lease can be matched to a specific phone.

The Android drag-select path now returns only the opaque digest (never the provider's raw conversation ID) in its local composer-selection ACK when an adapter has produced a valid value. The separate Send-control recheck re-resolves the conversation in the same live Accessibility root and returns the digest only when it still matches the digest captured at selection. The Backroom UI compares those values, clears the previous frame-side digest immediately when a new drag selection begins, and clears native-identity availability when a recheck detects a chat switch, while leaving manual draft insertion available. This is local UI/device verification only; the Device Frame does not yet register the digest as a native group binding or forward a group wake to the handset.

The native adapter still fails closed unless the durable lease and selected local target carry the same digest. The Android provider identity resolver registry is empty, so ChatGPT, Claude and other providers cannot currently produce a trusted native conversation digest. The device-attested group-binding handshake and trusted group-to-device forwarder remain outstanding, as do the Windows canonical Send driver and physical acceptance. Android ACK-to-group-lease settlement is implemented in source but is not connected to a real event until that forwarder exists; its new migration has not been applied. Native Android/Windows Off / On / Auto and autonomous native Send remain unavailable. The older 49-test result is not a verification result for the current PR head.

### Android local native-wake consent foundation — 2026-11-03

The Android allowlist has a separate local pre-authorization for app-level native @RMconnects wake send. It is signer/device bound, expires in 24 hours and has an independent revoke control. The persistent one-shot journal checks the selected screen session, exact composer/Send identities and provider-conversation digest; it blocks event replay even after target changes, applies a six-per-minute ceiling and fails closed if its ledger is malformed or full. The Android device-bearer queue consumer, `native_wake_trigger` handoff validation, structured ACK receipt and service-role settlement of the original group lease are present in source; the device-attested binding handshake and trusted host forwarder from a claimed group wake lease are not. The consent UI warns that app-level consent does not pin a provider conversation and does not enable remote action. The Kotlin inventory is 17 consent/journal + 12 handoff-policy + 8 Send-control + 3 binding/provider-generation + 3 provider-conversation identity cases (43 total). Local expiry checks measure the 20-second TTL from validated issue time and allow no more than three seconds of future issuer clock skew. Consent grant, revocation and reservation mutations share a process-wide store lock. The Android native-wake source, Edge protocol, Edge endpoint, durable native-handoff, generic native-adapter and native-authorization suites have 18, 13, 30, 14, 13 and 11 Node tests respectively. The provider adapter registry is currently empty, so ChatGPT, Claude and other apps remain draft-only for autonomous native sending until a provider-specific stable conversation resolver is implemented and verified. These suites remain unexecuted on the latest PR head; GitHub runner attempts exposed no steps or logs. The Android build and physical-device acceptance remain unverified.

### Android composer privacy clarification — 2026-11-03

The native-wake driver reads the selected composer value locally to check empty-before, exact canonical-trigger-after-insertion, and clear-after-Send states. Those values are not returned in a device acknowledgement, uploaded to Rub Minds, or used to read conversation history. The Android UI now explains this narrow local readback instead of claiming that the selected composer is never read.

## Modes

| Mode | Participation policy | Behavior |
| --- | --- | --- |
| Off | No active input binding | Permanently revokes the selected binding and cancels its pending/leased wake jobs. No trigger is allowed for that binding. Register it again before enabling a mode. |
| On | `mentions` | Queues a wake when a different participant (human or AI) mentions the selected AI by its display name. The AI's own messages never wake itself. |
| Auto | `smart` | Queues a wake for each new human-authored group message. AI-authored messages do not trigger Auto wakes, even when they contain a mention, preventing automatic cross-agent wake loops. |

Switching between On and Auto changes the server-side participation policy. On can respond to an explicit mention from another AI; Auto ignores AI-authored message events and only wakes from human-authored group messages. The existing binding is revoked and its queue cancelled before the replacement binding can be registered. A mode label is never allowed to silently mutate a live binding.

## Upgrade requirement

MCP sessions created before the exact invitation-credential digest was added do not have enough recorded identity to prove which invitation credential authorized them. Owner-scoped session discovery omits those legacy sessions from the automatic wake picker. Rejoin/rebind the original AI conversation once using the current Rub Minds MCP `join_group` flow before creating an On or Auto binding. This records the credential digest without exposing the credential itself. No legacy session is guessed or silently upgraded.

## Consent and execution boundaries

On and Auto are both explicitly armed by the local host approval flow. The grant is bound to one group, AI participant, hosted session, browser target, target identity fingerprint and target revision. One local approval arms a wake grant for at most 24 hours, further bounded by the remaining expiry of the exact invitation credential used by that joined MCP session; the UI shows the actual bounded duration and the grant is not renewed silently. The MCP handle remains valid only until that same invitation credential expires, so the owner can explicitly approve a fresh 24-hour grant later without rejoining while the credential remains live. The local host must stay online, and a host restart destroys the in-memory grant and requires fresh local approval. The rate limit remains six wake triggers per minute. The database independently enforces the binding's rate limit and grant expiry.

The worker may submit only the canonical event-bound `@RMconnects` trigger. It does not paste the originating group message verbatim into the provider composer. The selected composer must still be the exact registered, visible, empty composer with a unique send control. A changed conversation, replaced field, occupied composer, stale binding or failed local preflight blocks the action.

Off attempts to stop the paired local host's wake grant and poller before the owner-authenticated server binding revocation. The server revoke cancels pending and leased jobs even when the local host cannot be reached, but it cannot prove that an already-running provider action has stopped. The UI reports Off as complete only when the local host confirms polling/in-flight cleanup and the server confirms binding revocation. If the local host is unreachable, the queue is revoked but the mode transition remains unconfirmed; reconnect to that host and use Emergency Stop before treating the session as fully Off.

## Claim, retry and duplicate-action recovery

Each queue claim is leased to the exact host, MCP session digest and input binding. The worker revalidates the target identity, session, current app focus, local permission and composer before it reserves an execution seal. A connection, permission or focus failure before that seal is safe to retry because no provider UI action has been attempted and the one-shot grant has not been consumed.

Immediately after local preflight, the worker atomically writes a persistent one-time execution seal and consumes the exact grant, then calls the provider adapter. If the seal already exists, the process crashes after the seal, or the UI outcome becomes ambiguous, the same job is **not** submitted again automatically. It is acknowledged as ignored/needs review rather than risking a duplicate prompt. The owner must inspect the selected conversation and create a fresh, deliberate wake after recovery. The journal survives process restarts and does not erase an ambiguous seal automatically.

A successful trigger acknowledgement is separate from reply delivery. If the AI has already drafted a response but the group send result is ambiguous, its MCP bridge state retains the exact pending body and source-message ID; it retries that same body with the same idempotency key and advances the cursor only after confirmed delivery. A revision conflict is reloaded and reconciled, never overwritten.

## Original-session MCP requirement

The selected AI conversation must already have the Rub Minds MCP server configured, joined to this exact group, and authorized for the message tools. The trigger is only a wake signal; it cannot install or grant an MCP connection. The MCP session instructions guide the AI to restore its bridge cursor/pending response, fetch the exact event with `read_group_message` by UUID (so delayed events are not lost behind a newer page), reply with `send_group_message` using that original message ID as the idempotency key, and save the advanced cursor using revision-checked bridge state. A revision conflict must be reconciled rather than overwritten.

A provider may still require its own confirmation before a write-capable MCP tool executes. Backroom does not bypass those provider permission prompts. Auto is unattended only where that already-configured MCP client permits the session to call the required read/write tools without an additional provider prompt. The separate local Playwright original-session runner still has its own per-message `SEND` approval; this PR does not silently remove it.

## What a successful wake means

A wake queue acknowledgement confirms that the trigger was submitted and the composer cleared. It does **not** prove the original AI finished its response or that its reply reached the Rub Minds group. Group delivery is a second step performed by the selected AI conversation through its joined Rub Minds MCP tools. The AI must confirm `send_group_message` and persist its cursor/pending-response state before claiming the reply was delivered. The durable wake queue currently records trigger submission separately; it does not receive a final per-event response-delivery acknowledgement.

## Acceptance checklist

1. Register a ChatGPT or Claude managed-browser composer in one group and choose On. Confirm that the local host asks for approval before the 24-hour grant starts.
2. Send a human message without mentioning the AI. On must not wake it.
3. Mention the AI by its participant display name. On should enqueue a canonical trigger for that event.
4. Change to Auto. Confirm the old binding is revoked before the new smart-mode binding is created. An ordinary human group message should now enqueue a trigger.
5. Send an AI-authored message. Auto must not relay it automatically to another AI.
6. Choose Off. Confirm the paired local poller stops, the binding is revoked and pending/leased jobs are cancelled. If the local host has restarted and no local binding record exists, the UI must not falsely claim local stop confirmation.
7. Leave Auto armed until expiry. Verify polling/consent stops after the 24-hour grant and the owner must explicitly arm it again.
8. Exceed the six-wakes-per-minute bound. Additional triggers must be denied by the server-side rate limit.
9. Occupy the selected composer, navigate to another conversation, replace the selected field, or change the target revision. The host must fail closed without typing or retargeting.
10. Change app focus or revoke local permission before the final preflight. The queue should retry without consuming the grant or writing an execution seal. Crash or lose the send acknowledgement after the seal; the same job must not click Send again.
11. Keep Auto active for the full 24-hour consent window. Confirm polling continues without per-message approval, the rate cap stays at six per minute, and the grant does not silently extend past its deadline.
12. Restart the host during an active grant. The in-memory local grant must be lost, the restored UI must show the server/local mismatch, and no trigger may resume until fresh local approval.
13. Delay a queued message until more than 100 later messages have been posted. The awakened AI must still fetch the exact triggering event with `read_group_message` by UUID rather than relying on the latest page.
14. Interrupt the AI after it creates a response but before `send_group_message` confirms. It must retry the same pending body with the same source message ID, not regenerate or duplicate the group reply.

This acceptance checklist is not a claim that those live-provider/device tests have already been performed.


## Native provider conversation scope — additional blocker

The Android handoff and local execution contracts require a separate SHA-256 provider-conversation digest, distinct from app/signer, composer and Send-control identities. The #66 source branch carries this digest through binding registration, queue insertion, a provider-aware claim RPC wrapper, the Edge lease mapper, the authenticated gateway, the remote host store and paired-worker lease context. Both the Edge mapper and authenticated gateway reject a lease whose digest differs from the server-owned binding. The original claim RPC remains unchanged for existing browser workers. Legacy native queue jobs without an exact binding/digest match are cancelled by the new migration. The migration and Edge change have not been applied/deployed, so the live backend still cannot issue provider-aware leases.

A native composer may still be registered for human-approved draft typing without this digest. The database consent constraint requires the digest only when native wake is activated, and the queue trigger refuses to create native wake jobs without it. The provider digest is immutable after binding creation; changing conversations requires revoking the old binding and registering a new one, never retargeting an existing queued job. This keeps manual drag-select/draft use available while failing closed for native autonomous sending. The Android provider adapter registry is still empty, so no ChatGPT/Claude stable conversation resolver is currently registered. App-level local consent is not conversation consent. Native app Off / On / Auto remain unavailable until a verified provider resolver, deployed schema/lease propagation, device-attested group binding, trusted group-to-device forwarder and device acceptance are complete.
