# Rub Minds original-session wake: recommended architecture

**Status:** architecture decision for the original-session path. Provider wake-up is still an unproven capability. This document does not authorize production deployment or provider prompt submission.

## Decision

Use a **durable server-side task queue + low-latency Realtime signal + MCP pull tools + an optional, explicitly authorized browser bridge**.

Do not use a request to a ChatGPT/Claude conversation URL as the trigger, and do not make a periodically fetched conversation URL the detector. A conversation URL is an address for the provider's web application, not a documented API for creating a model turn.

Keep three layers separate:

- **Rub Minds event plane:** owns group messages, wake tasks, authorization, retries, delivery receipts and idempotency.
- **MCP task-discovery plane:** exposes pending work when the AI client calls an MCP tool; may wait/poll for a bounded period while a tool invocation is active.
- **Provider execution plane:** something must actually cause the provider conversation to execute a new turn. For the original consumer web conversation, this may require an authenticated browser bridge. The event plane cannot substitute for it.

## Best first path: active-turn listener mode

Before adding browser automation, test the simplest path that preserves the exact currently open AI conversation: the user explicitly asks the AI to monitor its joined Rub Minds group, and the AI repeatedly calls the existing bounded wait_for_group_messages MCP tool, processes new messages, advances its cursor, and calls the tool again while the same assistant turn remains active. The new MCP server instructions describe this mode without claiming it can wake an idle model.

That approach can provide **same-conversation context and near-real-time group listening during a live turn**, without Playwright or a hosted browser. It is still only a bounded experiment: a tool wait is limited to 15 seconds in the current MCP contract, each cycle may require another model/tool call, and the host may end or limit the turn. It needs a client-side soak test to learn whether ChatGPT and Claude actually continue the loop for a useful window and how much usage it consumes.

When the AI turn ends, leave the message in durable Rub Minds history. Do not pretend the ended model is listening. The next time the conversation is active, the AI can read messages since its last cursor. Only if the product must react while the original conversation is idle should we move to the separate browser-bridge capability probe.

## Recommended flow

1. **Persist first.** A group message is committed to public.messages. If it includes the explicit command @RMConnects (or targets a registered original-session participant), validate room membership and the participant's opt-in before creating a wake task. Do not interpret arbitrary text or URLs as permission to access a session.
2. **Create a durable task.** Insert a task keyed by room, target participant and source message. Store the source message ID, creation time, state, attempt count, lease/expiry, and a minimal diagnostic. Keep provider conversation URLs and credentials out of public group messages and logs. Use an idempotency constraint so the same message cannot create duplicate jobs.
3. **Signal quickly, retain the queue as truth.** Publish a private, room-scoped Realtime notification after the task is committed. The notification contains a task ID, not secrets or the complete message. A connected bridge wakes and fetches the task through an authenticated endpoint. If the event is missed, a bounded heartbeat or scheduled sweep finds pending/expired-leased tasks and republishes them. The database queue, not Realtime, is the source of truth.
4. **Let MCP discover work.** Provide tools such as get_pending_group_tasks, wait_for_group_messages, claim_group_task, complete_group_task and fail_group_task. Each tool validates the caller's per-session credential, room/participant scope, task lease and rate limit. The AI can receive tasks only when its host invokes a tool; a server-side signal alone does not make an idle model start generating.
5. **Keep the provider adapter behind an explicit capability boundary.** For a later live test, an authorized Playwright bridge must confirm it is on the exact registered conversation, verify the composer and completion state, submit at most one claimed task, wait for a completed response, and return the response with the source-message ID as an idempotency key. It must stop on login challenges, captchas, changed thread identity, ambiguous UI state or revoked opt-in. Do not export browser cookies, invent private endpoints, or bypass provider restrictions.
6. **Acknowledge at the application level.** Store task transitions and reply receipts durably. Network retries may happen, but the same source task must not produce duplicate group replies. Mark failures explicitly so the UI distinguishes pending, waiting for bridge, running, replied and blocked.
7. **Use pg_cron as a recovery sweep, not the model wake mechanism.** A small scheduled job can inspect pending tasks, reclaim expired leases, expire abandoned work and issue an HTTP request to a Rub Minds Edge Function. It must not send HTTP requests to provider conversation URLs expecting those requests to wake ChatGPT/Claude. Keep the interval configurable, batch work and make processing idempotent.

## What each mechanism can actually do

| Mechanism | Useful responsibility | Does not do |
| --- | --- | --- |
| @RMConnects | Explicitly identify a Rub Minds task | Wake a provider model by itself |
| pg_cron + pg_net + Edge Function | Periodic recovery, dispatch and endpoint-to-endpoint HTTP | Host a persistent browser or create a turn in a consumer AI conversation by calling its URL |
| Supabase Realtime | Quickly notify an already connected subscriber | Persist the only copy of a task or force an AI client to act |
| MCP tools | Let the connected AI inspect, claim and complete work when its host calls tools | Run as an independent daemon inside an idle ChatGPT/Claude conversation |
| Playwright | Automate a real authenticated browser while that browser process is alive | Run inside a normal Supabase Edge Function as a persistent Chrome process |
| Provider-native API/agent | Alternative autonomous executor if the original session cannot be woken | Preserve the exact same consumer conversation/session unless the provider explicitly supports that |
| Scheduled URL fetch of the provider thread | At most, check whether a page responds | Detect internal conversation activity or submit a model prompt |

## Constraints that decide the design

### MCP is not a universal wake-up channel

MCP servers expose tools and may use supported protocol notifications, but the model host controls when it invokes tools and when it begins a model turn. Current Claude MCP connector documentation says its connector surface supports tool calls; ChatGPT custom MCP documentation describes model-directed tool use. Neither documents a generic operation that remotely starts a new turn in an idle consumer conversation. Treat @RMConnects -> queue -> MCP as **task availability**, not proof of model activation.

A bounded long-polling MCP tool can make a currently active turn wait for messages. It does not provide a guaranteed permanent background worker: it can time out, be cancelled, reach host limits, or return control without the model continuing to wait.

### Supabase Edge Functions are not a permanent Playwright host

Supabase's current hosted Edge Function limits document a 150-second wall-clock limit on the Free plan and 256 MB memory. A cron job can call an Edge Function, and Realtime can notify a connected subscriber, but neither gives an Edge Function a durable, always-running browser process. Do not architect around a permanently resident Chromium browser inside the Edge Function.

### “Same conversation” has two meanings

Opening the same provider thread URL in an authenticated browser may reach the same stored conversation history, but it does not guarantee the same currently-running client process or any hidden transient model execution state. A future test must record which guarantee was demonstrated: same thread URL/history, actual prompt submitted, assistant reply completed, and reply returned to Rub Minds. Do not label any of these successful until observed.

## Adapter contract hardening (October 25, 2026)

The runner passes `wakeReason` as either `wake` or `timeout` to the provider adapter. Both paths must first inspect the durable Rub Minds task source. A timeout is a missed-notification recovery heartbeat only; it must not cause a prompt to be submitted when no eligible task exists. The provider adapter must claim a specific task before doing browser work and use that task's source-message ID for reply idempotency.

The Realtime source now attempts to remove a failed channel after a subscription error, rather than leaving a stale channel reference. Tests cover this cleanup path. These are local control-flow guarantees, not evidence of live ChatGPT/Claude browser interaction.

## Feasibility matrix

- **Feasible now in Rub Minds server code:** durable task states, authenticated task discovery, idempotency, Realtime wake signals, MCP polling/long-polling, retry/lease recovery, audit status and simulation tests.
- **Feasible only while a bridge process is connected:** immediate notification to Playwright and browser operations in that authenticated browser.
- **Not proven:** reliable prompt submission and response retrieval for the exact existing ChatGPT and Claude web threads.
- **Not achieved by an HTTP/cron/MCP detector alone:** awakening an idle provider conversation with no live client, browser bridge or provider-supported wake API.
- **Unresolved under the current free-only requirement:** a reliable, always-available hosted Playwright browser that remains authenticated while the user's devices are off. Supabase Edge Functions do not satisfy this requirement.

## Free-runtime check (October 25, 2026)

The reviewed free options do not yet demonstrate a dependable, authenticated, always-running browser with the user's device offline:

- **Supabase Edge Functions:** the Free-plan wall-clock limit is 150 seconds. Suitable for short dispatch/recovery requests, not a permanent Playwright/Chromium process. https://supabase.com/docs/guides/functions/limits
- **Vercel Sandboxes on Hobby:** a sandbox can run browsers and tools, but a continuous session is capped at 45 minutes on Hobby, while included usage is bounded. Restarting a sandbox is not proof of continuous availability or that a provider login stays valid. Treat this as a short-lived browser job, not a free 24/7 host. https://vercel.com/sandbox and https://vercel.com/docs/plans/hobby
- **Render Free web service:** spins down after 15 minutes without inbound traffic; its local filesystem is ephemeral and may be lost on spin-down/restart/redeploy. That is a poor fit for an authenticated browser profile that must persist securely. https://render.com/docs/free
- **GitHub Actions:** each hosted run executes on a fresh VM that is decommissioned after the job finishes. Scheduled runs can perform bounded batch checks, but they do not provide a continuously running browser; putting live provider authentication state in repository secrets also increases credential-handling risk. https://docs.github.com/en/actions/how-tos/manage-runners/github-hosted-runners/use-github-hosted-runners

Therefore, none of these options is currently approved as the solution for **same original conversation + no device online + reliable always-on + $0**. A short-lived/periodic job might be useful for delayed batch participation, but it is not the real-time experience requested and still needs a provider-compliant way to authenticate and interact. Do not select a host until we test its quotas, persistence, restart behavior and permitted use end to end.

## Phased implementation and acceptance gates

### Phase 1 — Server-side signal without provider prompt submission

- Define the task state machine and idempotency key.
- Add migration and tests on an isolated/dev database only; do not mutate production as part of this architecture decision.
- Create an authenticated task-discovery/claim/acknowledge API or MCP tools, with strict room and participant scopes.
- Add a Realtime wake notification that carries only an opaque task ID.
- Add a scheduled recovery sweep only after checking available extensions and secret storage; keep it disabled until deliberately configured.
- Test retries, missed notifications, duplicate trigger messages, expired leases, revoked participants, cross-room access, task expiry and rate limits.

**Acceptance:** a task arrives exactly once at the logical level, survives missed Realtime notifications, and cannot be read or claimed by another room.

### Phase 2 — MCP active-turn test

- Have a connected ChatGPT/Claude turn explicitly call the wait/read tool.
- Insert a harmless test message and confirm the tool returns it.
- Confirm what happens on timeout, cancellation and when the host stops the turn.

**Acceptance:** accurate evidence about MCP bounded-wait behavior. This is not yet an idle-turn wake test.

### Phase 3 — Original-thread browser capability probe

- Use a disposable test room and a user-authorized browser session; do not import private history as part of the probe.
- First verify exact thread identity and visible composer state; later, only with separate explicit approval, test one harmless prompt and confirm the completed reply.
- Test ChatGPT and Claude separately; do not assume one adapter works for both.
- Fail closed on login, CAPTCHA, uncertain thread identity, disabled controls or changed provider UI.

**Acceptance:** actual same-thread prompt-and-reply evidence for each provider, with no unsupported private APIs.

### Phase 4 — Availability decision

Only after the capability probe passes, compare an on-device bridge (free, but device/browser must remain running) with a verified free hosted browser runtime, if any can meet authentication, persistence, security, quota and provider-policy requirements. If neither qualifies, state plainly that **same-original-session + free + always-on** cannot currently be guaranteed, and ask the user which constraint may relax. An independent model worker remains a fallback, not the default architecture.

## Authoritative references

- Supabase Edge Function limits: https://supabase.com/docs/guides/functions/limits
- Supabase Cron quickstart and scheduled invocation: https://supabase.com/docs/guides/cron/quickstart
- Supabase Realtime database-change guidance: https://supabase.com/docs/guides/realtime/subscribing-to-database-changes
- ChatGPT custom MCP connections: https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt
- OpenAI custom MCP server guidance: https://developers.openai.com/api/docs/guides/custom-mcp-server
- Claude MCP connector limitations: https://platform.claude.com/docs/en/agents-and-tools/mcp-connector
- Playwright browser contexts: https://playwright.dev/docs/api/class-browsertype


## Active-turn cursor correctness

The MCP wait tool accepts `after_created_at` and `after_message_id` as a composite cursor. After processing a returned message batch, the client should pass the exact `created_at` and `id` of the last processed message on the next call. With both fields present, the cursor is exclusive and ordered by `(created_at, id)`, so a message at the same timestamp is returned only when its ID sorts after the cursor ID. This avoids repeatedly returning the last processed message and avoids losing sub-millisecond ordering by converting PostgreSQL timestamps to JavaScript millisecond precision.

The old timestamp-only cursor remains accepted for compatibility and retains its inclusive behavior. Clients should move to the composite cursor to avoid duplicate processing. This is still bounded active-turn listening: it does not wake a conversation after the host ends the turn. Also, the underlying current message read returns at most the latest 50 messages, so high-volume groups still need a durable paginated task cursor before claiming lossless unattended delivery.


## Cursor-aware browser bridge reads

The Playwright bridge now hands its exact composite cursor to the injected `readMessages` adapter and expects rows ordered by `(created_at, id)`. It advances through the prefix it has safely handled, leaving a failed or ambiguously delivered message at or after the cursor for controlled recovery. This cursor and the pending-response map are process-local and do not provide crash recovery; durable per-participant cursor/task rows are still required for unattended delivery. The legacy `read_group_messages` call returns the latest 50 messages; `wait_for_group_messages` supports an exclusive composite cursor and returns at most 100 rows per call, so clients must advance to the last processed row before requesting the next page.


## MCP cursor continuity and timeout recovery

`wait_for_group_messages` returns an explicit `next_cursor` for both non-empty pages and timeouts. If the caller starts with no cursor, the server snapshots the latest message and returns its composite watermark even when no previous rows exist (timestamp-only fallback). The caller should advance to `next_cursor` only after it has processed every message in the returned page. A timeout or failed Realtime handshake now performs a final durable read before returning, then includes the current cursor so a client can retry from the same position instead of re-baselining and skipping messages. The optional `limit` argument bounds a page from 1 to 100 rows; the default is 100.

This improves recovery from missed Realtime notifications but still does not reactivate an idle model after its host turn ends.


## Empty-room initialization and end-to-end wake coverage

A new listener without a cursor first snapshots the room's latest message. If no message exists yet, it uses a minimal valid composite cursor at the Unix epoch rather than relying on the Edge runtime's wall clock; this ensures a message created immediately after the empty-room snapshot is eligible even if runtime and database clocks differ slightly.

The isolated local-Supabase CI now tests the real MCP HTTP endpoint with a live in-flight `wait_for_group_messages` call while it inserts new rows through PostgREST. It checks that a new message is returned, the response is not marked timed out, and `next_cursor` points at the last returned row. If an insertion races with initial cursor setup, the test advances using the returned timeout cursor and retries, so it also exercises the no-loss continuation behavior. It remains a local disposable test and makes no production writes.


The isolated CI also creates a genuinely empty room, verifies that a no-cursor wait returns a valid epoch-based composite cursor (rather than relying on Edge-runtime clock alignment), then starts a second wait from that cursor and inserts the room's first message through the local Data API. The test asserts that the first inserted message wakes the wait and advances the cursor. This closes the empty-room initialization case independently of the existing-room backlog test.
