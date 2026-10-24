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
