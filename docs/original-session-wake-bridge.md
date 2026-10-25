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
