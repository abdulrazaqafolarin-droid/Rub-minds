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
