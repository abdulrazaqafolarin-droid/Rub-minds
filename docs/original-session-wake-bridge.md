# Original-session wake bridge: implementation slice

## What this changes

Adds a bounded runner that can connect an already-authorized Playwright bridge to a wake-source adapter. It waits for a wake notification or heartbeat, checks the existing group-message transport through the bridge, respects a reply cap, supports cancellation, and stops after a configurable number of consecutive failures.

## What this does not claim

This is **not** a remote wake-up implementation by itself. Supabase HTTP/pg_cron can invoke an HTTP endpoint or scheduled Edge Function, but it cannot execute Playwright in a browser that is not running. The runner requires a live process with an authenticated, explicitly authorized browser session. It also does not use undocumented ChatGPT/Claude APIs or scrape guessed provider selectors.

## Intended end-to-end path

1. A new Rub Minds group message is persisted.
2. A server-side event/queue or Supabase Realtime signal tells the connected bridge that work may exist.
3. A live original-session runner wakes and checks the durable message store (heartbeat provides recovery if a realtime notification is missed).
4. A provider-specific adapter submits the group message into the exact existing conversation and waits for its reply.
5. The adapter posts the reply to Rub Minds with the source message ID as an idempotency key.

The difficult, not-yet-proven part is step 4 on real ChatGPT and Claude web sessions, including whether the session can remain available while the user's device is offline. This PR does not claim that capability is complete.

## Safety and resource bounds

- Explicit opt-in is required to start the runner.
- The caller supplies the authorized bridge and wake source; credentials/cookies are not copied or exported.
- Replies and consecutive failures are bounded.
- Cancellation stops the wait loop.
- The runner does not fall back to an independent model automatically.

## Verification

The node tests cover explicit approval, wake/heartbeat behavior, reply limits, cancellation, and fail-closed handling. Run:

```sh
npm run test:original-wake
```

The tests use fakes and do not contact provider sites, access user sessions, or modify production.


## Added transport adapter

`SupabaseRealtimeWakeSource` subscribes to `INSERT` events for one room, queues a bounded wake signal, and supports heartbeat timeout, cancellation, and cleanup. The bridge must still perform an authorized durable message read after each wake. Realtime is a notification path, not the source of truth. The subscription requires a client authorized to receive that room's message events; the adapter does not bypass RLS or configure production publication settings.


## Runner adapter contract

The runner is deliberately single-use: it closes its wake source during cleanup, so a restart must construct a new runner and a fresh source. `bridge.step` receives an `AbortSignal`, `wakeReason` (`wake` or `timeout`) and `remainingReplies`. The provider adapter must honor cancellation, check/claim durable work before submitting anything, and return a typed result with an integer `sent` count no greater than the supplied remaining cap.

Recognized non-retry terminal states are `browser_closed`, `limit_reached`, `blocked`, `auth_required`, `thread_mismatch`, and `cancelled`. An `error` result or thrown exception uses the bounded retry/error threshold; unknown statuses or invalid reply counts fail closed. Timeout heartbeats only trigger a queue check, not prompt submission. The returned status preserves terminal blockers so an operator can distinguish an authentication challenge from a normal stop.

The unit tests now cover an already-aborted signal, cancellation during the provider adapter call, single-use lifecycle, malformed reply counts, adapter error results, terminal provider blockers, and cleanup after startup failure. These remain simulated adapter tests; they do not prove that a real ChatGPT or Claude page can be woken.


## Provider submission and delivery recovery

The existing `PlaywrightSessionBridge` can now be passed directly to `OriginalSessionWakeRunner`; it receives the runner's cancellation signal and reply budget. Provider errors are **not** automatically retried unless the adapter explicitly marks them `safeToRetry: true` or `submissionState: "not_submitted"`. An ambiguous provider outcome blocks that message rather than risking a duplicate prompt. Terminal bridge results always include an integer `sent` count, including zero for a closed browser or exhausted limit.

Once a provider answer is complete, it is held as a pending response until the Rub Minds transport acknowledges it. A failed/ambiguous delivery retries the same response with the same source-message ID, relying on the server-side deduplication constraint. This pending-response cache and the ambiguous-message blocker are currently **in-memory only**. A process crash can lose that state; a durable task/response ledger is still required before unattended or crash-recoverable operation can be claimed.

The isolated command `npm run test:original-wake` covers the Playwright session bridge, wake runner, and Realtime wake source. It uses fake browser/transport adapters and never submits a prompt to ChatGPT or Claude.


## Startup and in-memory deduplication boundaries

The runner initializes the session bridge's baseline **before** starting its Realtime subscription. By default, messages already present in the room at startup are marked as seen rather than replayed into the provider conversation. This avoids accidentally prompting the original AI about old group history. Set `processExistingMessages: true` only when the owner explicitly wants backlog processing. Messages arriving after the baseline remain eligible, including messages sent during the startup-to-subscription hand-off because later steps read the durable group messages.

The seen-ID cache is bounded (default 2,000 IDs, configurable with a hard range). This prevents unbounded memory growth, but does not make the bridge crash-safe: the baseline, seen IDs, pending answers, and ambiguity blocker are still process-local. A persistent worker needs a durable per-participant cursor and task/response ledger before it can claim lossless unattended processing.


## Concurrent-step guard

A session bridge now allows only one `step()` operation at a time. A second concurrent call returns `busy` without reading messages or submitting a second provider prompt. This prevents two overlapping wake notifications from racing the in-memory deduplication set. The guard is process-local; a distributed or crash-recoverable deployment still needs durable task claims and idempotent reply receipts.


## Identity, acknowledgement, and stop semantics

The session bridge now requires its own Rub Minds participant ID, so it can exclude its own messages rather than accidentally building a self-reply loop. The Realtime wake source accepts only UUID-form room IDs before building the `room_id=eq.<uuid>` filter, and custom channel names are length-bounded.

A group-send callback must throw on transport failure or return an explicit rejection (for example `{ ok: false }`). Negative acknowledgements are treated as failures: the completed provider answer stays pending and is retried with the same source-message ID, without asking the provider a second time. Undefined results remain compatible with existing callbacks, so the adapter must not silently resolve on failed sends.

Calling `stop()` now aborts the standalone `PlaywrightSessionBridge.run()` loop, including its polling wait, and passes that signal to message/provider callbacks. If the provider has already completed an answer at the time cancellation arrives, the answer remains in the in-memory pending-delivery map and is not sent after the cancellation check. Provider adapters and transport callbacks must honor their supplied `AbortSignal`; the browser UI itself can still have an already-submitted operation in flight, which remains an ambiguous outcome that should fail closed.


## Composite cursor contract for message readers

The bridge now tracks a composite `(created_at, id)` cursor in addition to its bounded seen-ID cache. Startup baselining advances the cursor to the newest valid message returned by the initial read; subsequent calls to `readMessages` receive both `cursor: { after_created_at, after_message_id }` and the same top-level fields, plus a batch limit. The adapter should return messages strictly after that cursor, ordered oldest-first by the same timestamp-then-ID ordering. The bridge sorts valid timestamps defensively and advances only after a message is safely ignored or its reply is acknowledged. A provider error, ambiguous submission, or pending delivery does not move the cursor past that message.

This is still an in-memory cursor, not a durable task ledger. It can prevent gaps across ordinary polling steps when the adapter honors the cursor, but a crash/restart resets it; before unattended operation, persist the per-participant cursor and pending-response state server-side. The legacy `read_group_messages` tool itself still returns only the latest 50 rows; the cursor-aware `wait_for_group_messages` path can read a bounded page after a composite cursor.


Cursor validation now requires both a parseable timestamp (with timezone and microsecond precision) and a stable non-empty message ID. Rows missing either part are not allowed to advance the exclusive cursor, even if their timestamp would otherwise sort later. The wake runner recognizes a concurrent `busy` bridge result as a non-fatal state; it waits for the next bounded signal rather than counting normal serialization as an adapter failure.


The MCP wait tool returns an explicit `next_cursor` on successful message pages and empty timeout/unavailable responses. A timeout or Realtime subscription failure triggers one final authorized durable read, so messages whose notifications were missed are still returned when present. The caller should keep the returned cursor unchanged on an empty timeout and advance to the cursor from a non-empty page only after processing every returned row. Page size is configurable from 1 to 100 (default 100).


The startup baseline read is deliberately independent of `maxMessagesPerStep`. That setting caps provider replies per poll, not history inspection. The bridge asks the injected reader for a bounded snapshot with a 100-row preference, but the current hosted `read_group_messages` tool exposes only the latest 50 messages; the cursor is initialized to the newest valid row in that returned snapshot. For an empty snapshot, the MCP transport supplies the epoch sentinel cursor so the first future message remains eligible. The injected reader should return a current snapshot, not use a long-poll that might yield live arrivals during initialization.


## Hosted MCP message transport adapter

`integrations/playwright/mcp-session-message-transport.mjs` now provides the concrete HTTP adapter between the session bridge and Rub Minds' hosted MCP message tools. Configure it with the MCP endpoint and the already-authorized Rub Minds session handle; `createBridgeAdapters()` returns the `readMessages` and `sendMessage` callbacks expected by `PlaywrightSessionBridge`. It uses a current message snapshot for startup baselining, then uses `read_group_messages` with the exact composite cursor for immediate bounded pages. `wait_for_group_messages` remains the separate Realtime long-poll tool. Replies pass the source message ID so the server can deduplicate transport retries.

The transport requires HTTPS except for explicit loopback development, rejects endpoints containing URL credentials/query tokens, validates the session-handle shape, uses bounded request timeouts and propagates cancellation, and does not log or expose the session handle. Its tests use a fake fetch implementation; they verify protocol framing and fail-closed behavior without making provider or production requests.


The factory has a dedicated fake-adapter integration test for this complete composition. Local disposable CI also exercises the concrete HTTP transport against the actual hosted-MCP Edge Function endpoint, verifying a read/send/read roundtrip with a stable `source_message_id`. This verifies the Rub Minds transport wiring, not ChatGPT/Claude page selectors or idle-thread activation.


## Cursor paging on `read_group_messages`

Composite pagination is now part of the `read_group_messages` tool itself, rather than being available only through the active-turn wait tool. Calling it with no arguments returns the legacy latest-message snapshot plus `next_cursor`; calling it with both `after_created_at` and `after_message_id` reads an immediate, bounded page strictly after that cursor, ordered by timestamp then ID. Empty results preserve the supplied cursor, and an empty initial room returns the epoch sentinel cursor. `limit` is optional and bounded to 1–100 (default 50).

`wait_for_group_messages` remains the separate long-poll/Realtime notification tool. The session bridge's `readMessages` adapter now uses `read_group_messages` for immediate snapshots/pages, keeping notification waiting separate from message retrieval.


## Durable state is now wired through the runtime

The runtime now loads the room-bound state snapshot before its first baseline/read and saves cursor, pending response and blocked-message status with optimistic revision checks. On restart, a stored cursor prevents a fresh baseline from jumping past unseen messages; a saved pending answer is retried under its source message ID without re-running the provider; an ambiguous provider result stays blocked across restarts. A revision conflict stops the runner rather than overwriting another process's state.

The persistence layer is backed by `rub_minds_mcp_bridge_state` through the authenticated MCP `load_original_session_bridge_state` and `save_original_session_bridge_state` tools. It is now part of the local runtime composition, but still requires the migration and updated hosted MCP Edge Function to be deployed before a production connection can use it. The browser/provider adapter remains injected and unverified for ChatGPT or Claude.


## Pre-prompt claim prevents concurrent duplicate provider turns

Before asking the original AI session to answer a new group message, the bridge now records a revision-checked `provider_prompt_in_progress` marker. Only the process that wins the durable compare-and-swap save may invoke the provider; another process using the same stale cursor gets a revision conflict before prompting. Once an answer is complete, the in-progress marker is replaced by a pending answer before group delivery. An explicitly safe-to-retry provider error clears the marker; an ambiguous provider outcome stays blocked.

A crash while a provider operation is in flight leaves a fail-closed marker requiring deliberate recovery. This intentionally prefers a visible blocked message over silently issuing the same prompt twice when the provider's outcome is unknown. Automated lease recovery is not claimed yet and remains a precondition for unattended always-on use.
