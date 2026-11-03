# Backroom interaction modes

## Scope

The first Off / On / Auto control is supported only by a live, registered managed-browser composer whose local host reports canonical wake capability. It is not a general-purpose automatic typing switch for native Windows apps, Android apps, terminals, or arbitrary desktop windows. Those surfaces retain their separate manual draft and local-approval flows.

## Native app-frame capability boundary — 2026-11-03

The Windows desktop frame and Android Phone Frame now have source-level drag-select composer targeting and local discovery/revalidation of a single nearby Send control. Windows keeps the full UI Automation identity in native Rust memory; Android keeps the accessibility-node identity in the phone service. Both report only bounded availability/reason status to the Backroom frame. The recheck never clicks, invokes, presses Enter or submits.

This is not the Off / On / Auto execution path. Both native frames remain draft-only and require their existing local typing approval. Native message sending, queue consumption, a device-bound wake grant, one-time execution seal, duplicate-action recovery and physical device acceptance are still outstanding. Do not present a successful Send-control recheck as permission to send or as native Auto support.

## Native canonical-wake adapter contract — 2026-11-03

A shared `NativeCanonicalWakeAdapter` interface and Node regression tests now define how an already-authorized durable event wake can be executed by a future Android or Windows accessibility driver. The interface binds one native target revision and requires the exact empty composer plus one unique, visible, enabled and identity-verified Send control. It accepts only the canonical event-bound `@RMconnects` prompt, requires proof that the durable one-time execution seal and one-shot local grant were acquired, and reports success only after the same composer clears.

This is a **contract, not an enabled device capability**. No Android or Windows platform driver implements the contract yet; a separate process-local native wake-grant authority and seal/consume helper now exist as source contracts, but no Android/Windows local approval screen or device-bound durable queue consumer is connected. The Android WebRTC `remote_text` channel remains draft-only and must not be used to transport durable wake jobs or invoke Send. Native Send, native Off / On / Auto, host-server composition, production backend changes and physical acceptance remain unavailable/deferred.

### Native wake contract verification — 2026-11-03

The native adapter now compares opaque SHA-256 composer and Send-control identity digests captured during preflight with the digests returned after the post-seal recheck. Target ID and target revision must also remain exact. The shared adapter was exercised through `dispatchClaimedWake`: 27/27 focused Node 22 tests passed, covering the seal/consume ordering, safe retry before the seal, and no replay after uncertain Send. This is policy/dispatcher verification only; no native platform Send driver or device queue consumer is wired.

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
14. Change app focus or revoke local permission before the final preflight. The queue should retry without consuming the grant or writing an execution seal. Crash or lose the send acknowledgement after the seal; the same job must not click Send again.
10. Keep Auto active for the full 24-hour consent window. Confirm polling continues without per-message approval, the rate cap stays at six per minute, and the grant does not silently extend past its deadline.
11. Restart the host during an active grant. The in-memory local grant must be lost, the restored UI must show the server/local mismatch, and no trigger may resume until fresh local approval.
12. Delay a queued message until more than 100 later messages have been posted. The awakened AI must still fetch the exact triggering event with `read_group_message` by UUID rather than relying on the latest page.
13. Interrupt the AI after it creates a response but before `send_group_message` confirms. It must retry the same pending body with the same source message ID, not regenerate or duplicate the group reply.

This acceptance checklist is not a claim that those live-provider/device tests have already been performed.
