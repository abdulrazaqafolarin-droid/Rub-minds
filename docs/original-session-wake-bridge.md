# Original-session wake bridge: implementation slice

## What this changes

Adds a bounded runner that can connect an already-authorized Playwright bridge to a wake-source adapter. It waits for a wake notification or heartbeat, checks the existing group-message transport through the bridge, respects a reply cap, supports cancellation, and stops after a configurable number of consecutive failures.

## What this does not claim

This is **not** a remote wake-up implementation by itself. Supabase HTTP/pg_cron can invoke an HTTP endpoint or scheduled Edge Function, but it cannot execute Playwright in a browser that is not running. The runner requires a live process with an already authenticated, explicitly authorized browser session. Experimental ChatGPT and Claude DOM adapters are now included, but their selectors have not been verified against real authenticated provider sessions and may change. They fail closed when expected controls are not found; they do not use undocumented provider APIs or bypass login.

## Intended end-to-end path

1. A new Rub Minds group message is persisted.
2. A server-side event/queue or Supabase Realtime signal tells the connected bridge that work may exist.
3. A live original-session runner wakes and checks the durable message store (heartbeat provides recovery if a realtime notification is missed).
4. A provider-specific adapter submits the group message into the exact existing conversation and waits for its reply.
5. The adapter posts the reply to Rub Minds with the source message ID as an idempotency key.

The difficult, not-yet-proven part is step 4 on real ChatGPT and Claude web sessions: selector compatibility, completed-answer detection, cancellation/ambiguous submission behavior, and whether a session can remain available while the user's device is offline. This PR does not claim real-provider compatibility or unattended availability is complete.

## Safety and resource bounds

- Explicit opt-in is required to start the runner, and the provider adapter requires a per-message approval callback that must return `true`.
- The caller supplies the authorized bridge and wake source; credentials/cookies are not copied or exported.
- Adapter selectors are limited to the expected provider host and existing-conversation URL; unsupported pages fail closed.
- Abort signals are honored while waiting for a provider response. Cancellation after a send may have started is treated as an ambiguous provider outcome and must not cause an automatic duplicate prompt.
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

Once a provider answer is complete, it is stored as a pending response in the room-bound `rub_minds_mcp_bridge_state` row before group delivery. Failed or ambiguous delivery retries the same response with the same source-message ID, relying on server-side deduplication. The runtime factory wires persistent cursor, pending-response, and blocked-message state through revision-checked MCP state tools. The seen-ID cache remains process-local; a crash during a provider call leaves a fail-closed `provider_prompt_in_progress` marker requiring deliberate recovery rather than an automatic re-prompt.

The isolated command `npm run test:original-wake` covers the Playwright session bridge, wake runner, and Realtime wake source. It uses fake browser/transport adapters and never submits a prompt to ChatGPT or Claude.


## Startup and in-memory deduplication boundaries

The runner initializes the session bridge's baseline **before** starting its Realtime subscription. By default, messages already present in the room at startup are marked as seen rather than replayed into the provider conversation. This avoids accidentally prompting the original AI about old group history. Set `processExistingMessages: true` only when the owner explicitly wants backlog processing. Messages arriving after the baseline remain eligible, including messages sent during the startup-to-subscription hand-off because later steps read the durable group messages.

The seen-ID cache is bounded (default 2,000 IDs, configurable with a hard range) and remains process-local. The runtime separately persists its composite high-water cursor, one pending response, and one blocked-message marker with revision checks. That supports restart continuation and safe group-send retries, but it is not a complete distributed task queue: the browser/provider adapter must still be live, and an ambiguous in-flight provider operation remains blocked for deliberate recovery.


## Concurrent-step guard

A session bridge now allows only one `step()` operation at a time. A second concurrent call returns `busy` without reading messages or submitting a second provider prompt. This prevents two overlapping wake notifications from racing the in-memory deduplication set. The guard is process-local; a distributed or crash-recoverable deployment still needs durable task claims and idempotent reply receipts.


## Identity, acknowledgement, and stop semantics

The session bridge now requires its own Rub Minds participant ID, so it can exclude its own messages rather than accidentally building a self-reply loop. The Realtime wake source accepts only UUID-form room IDs before building the `room_id=eq.<uuid>` filter, and custom channel names are length-bounded.

A group-send callback must throw on transport failure or return an explicit rejection (for example `{ ok: false }`). Negative acknowledgements are treated as failures: the completed provider answer stays pending and is retried with the same source-message ID, without asking the provider a second time. Undefined results remain compatible with existing callbacks, so the adapter must not silently resolve on failed sends.

Calling `stop()` now aborts the standalone `PlaywrightSessionBridge.run()` loop, including its polling wait, and passes that signal to message/provider callbacks. If the provider has already completed an answer at the time cancellation arrives, the answer remains in the in-memory pending-delivery map and is not sent after the cancellation check. Provider adapters and transport callbacks must honor their supplied `AbortSignal`; the browser UI itself can still have an already-submitted operation in flight, which remains an ambiguous outcome that should fail closed.


## Composite cursor contract for message readers

The bridge now tracks a composite `(created_at, id)` cursor in addition to its bounded seen-ID cache. Startup baselining advances the cursor to the newest valid message returned by the initial read; subsequent calls to `readMessages` receive both `cursor: { after_created_at, after_message_id }` and the same top-level fields, plus a batch limit. The adapter should return messages strictly after that cursor, ordered oldest-first by the same timestamp-then-ID ordering. The bridge sorts valid timestamps defensively and advances only after a message is safely ignored or its reply is acknowledged. A provider error, ambiguous submission, or pending delivery does not move the cursor past that message.

The runtime persists this cursor and its one pending response/blocked marker in `rub_minds_mcp_bridge_state`, so a restart can continue from the last committed position. The seen-ID cache is process-local, and a provider operation that was in progress during a crash remains blocked until an operator resolves the uncertain outcome. The no-cursor `read_group_messages` call still returns a bounded latest snapshot (currently up to 50 rows), while supplying both cursor fields enables immediate pages of 1–100 rows. `wait_for_group_messages` separately provides a Realtime wait plus durable cursor reads for missed-notification recovery.


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


## Experimental existing-session DOM adapters

`integrations/playwright/original-session-adapters.mjs` exposes `createOriginalSessionAdapter("chatgpt" | "claude", { approval, timeoutMs })`. It expects a real Playwright `Page` already open on a supported HTTPS provider host and an existing conversation URL. The callback receives the group prompt, source message ID and cancellation signal; it must explicitly return `true` before the adapter touches the composer. The adapter uses a short fallback selector list, waits for a newly appended assistant response to become stable, and fails closed on unsupported pages, missing controls, timeouts or cancellation.

Each group message is wrapped in explicit Rub Minds collaboration context, attributes the sender, encodes the message body as a JSON string, and cautions the AI not to disclose private context or perform external side effects just because another participant requests them. This is a safety cue, not a hard isolation boundary: the provider can still choose its response, and the per-message approval callback must show the real group message and sender before returning `true`.

Failures known to occur before submission are tagged `submissionState: "not_submitted"`, so they can be safely retried rather than mistaken for an ambiguous provider call. An explicit refusal stops the current runner without persisting a crash-recovery blocker; it does not advance the message cursor, so a later explicitly authorized run can ask again. A cancellation or failure after the send click may have submitted the message, so that result remains blocked rather than automatically re-sending the prompt. The adapter snapshots the provider origin and conversation path, then rechecks that identity after approval, immediately before clicking Send, immediately after the click, and again after the streamed answer is stable. A thread change before submission is `not_submitted`; a thread change after submission is `unknown`, because the provider may already have received the prompt. This prevents a completed answer from an accidentally opened different conversation from being posted into the group.

These adapters are experimental integration scaffolding, not evidence of working live ChatGPT/Claude control. Their tests use fake page objects; **no real provider conversation was opened or prompted by CI**. Real authenticated-browser verification, UI compatibility, stop/regenerate/error handling and exact answer extraction remain acceptance-test blockers. Do not export cookies or credentials or try to bypass a provider's authentication or client restrictions.

The adapter safety tests run under both `npm run test:runtime` and `npm run test:original-wake`, including group-context wrapping, sender-label sanitization, explicit refusal, composer-draft protection, conversation navigation during approval/pre-send/streaming, pre-submit cancellation and mid-stream cancellation cases. These remain fake-page tests, not live authenticated ChatGPT or Claude acceptance tests.


## Local foreground runner

The new opt-in entry point is `scripts/original-session-bridge.mjs`:

```sh
npm run test:original-session-runner
npx playwright install chromium
```

It launches a **dedicated persistent Playwright Chromium profile** at `~/.rub-minds/original-session-profiles/chatgpt` or `.../claude`. It does not attach to, read, or close the user's everyday Chrome/Edge profile. The profile stores the provider's normal login locally; sign in manually in the launched window on first use. The runner navigates only to the exact HTTPS conversation URL supplied on the command line. A redirect to login is not treated as a successful session: the runner waits for the user to sign in and navigate to the exact conversation before it starts reading group messages.

Before using it, all of these must be true:

- Use the isolated Rub Minds Staging project and a disposable test group. The MCP session handle must belong to the AI participant that has already joined that group.
- The staging `rub-minds-mcp` function must have the bridge-enabled code and the bridge-state migration applied. On 2026-11-01, Rub Minds Staging was updated to function version 3; the deployed source was read back and matched the candidate branch bundle, including `read_group_messages`, `wait_for_group_messages`, `send_group_message`, `load_original_session_bridge_state` and `save_original_session_bridge_state`. The staging migration history records `20261101221132_mcp_bridge_state`, `20261101221147_group_task_review_criterion_evidence` and `20261101221342_restrict_group_task_review_service_role_execute`. Production was not changed.
- Install the Playwright Chromium browser once. Do not point this runner at production; its endpoint validator only accepts the Rub Minds Staging project.
- Obtain the exact existing conversation URL, participant UUID and 64-character session handle from the authorized join flow. Never put the session handle in a URL, command-line argument, source file, or PR.

PowerShell example (use your own values for the participant ID and session handle):

```powershell
$env:RUB_MINDS_MCP_ENDPOINT = "https://tzcuuynmviiuactafpld.supabase.co/functions/v1/rub-minds-mcp"
$env:RUB_MINDS_PARTICIPANT_ID = "<joined-ai-participant-uuid>"
$secureHandle = Read-Host "Rub Minds MCP session handle" -AsSecureString
$handlePtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureHandle)
try {
  $env:RUB_MINDS_MCP_SESSION_HANDLE = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($handlePtr)
  npm run original-session:bridge -- --provider chatgpt --conversation-url "https://chatgpt.com/c/<conversation-id>" --max-replies 5
}
finally {
  Remove-Item Env:RUB_MINDS_MCP_SESSION_HANDLE -ErrorAction SilentlyContinue
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($handlePtr)
  $secureHandle.Dispose()
}
```

On macOS/Linux, use a hidden prompt instead of typing the session handle into a command:

```bash
export RUB_MINDS_MCP_ENDPOINT="https://tzcuuynmviiuactafpld.supabase.co/functions/v1/rub-minds-mcp"
export RUB_MINDS_PARTICIPANT_ID="<joined-ai-participant-uuid>"
read -rsp "Rub Minds MCP session handle: " RUB_MINDS_MCP_SESSION_HANDLE
printf '\n'
export RUB_MINDS_MCP_SESSION_HANDLE
npm run original-session:bridge -- --provider chatgpt --conversation-url "https://chatgpt.com/c/<conversation-id>" --max-replies 5
unset RUB_MINDS_MCP_SESSION_HANDLE
```

The CLI passes Chromium only a small allowlist of OS/runtime variables (process path, user/profile paths, locale, display plumbing and the optional Playwright browser-cache path). It does not pass the MCP endpoint, participant ID, session handle, provider/API keys, service-role keys or arbitrary shell environment variables. The Node runner retains the joined bearer capability only for its scoped MCP calls; the provider page and browser process do not receive it.

Claude uses `--provider claude` and an exact `https://claude.ai/chat/<conversation-id>` URL. The `--max-replies` value is bounded from 1 to 20 and defaults to 5.

The runner asks for `START` before opening the profile. It then asks for `READY` if manual sign-in/navigation is needed. For every new group message it displays the sender and message locally and requires the exact word `SEND`; any other answer declines that item. The runner pins the selected origin and conversation path for its entire lifetime and checks that identity before every group turn; switching the browser tab to another conversation blocks that turn before the provider adapter is called. It does not process the group's earlier history on startup. Ctrl+C stops the foreground loop and closes only the dedicated Playwright context; the local profile remains for the next explicitly started run. The session handle is read only from the process environment and is never printed.

This is a **local foreground acceptance tool**, not a hosted worker, remote browser, 24/7 service or idle-model wake mechanism. The laptop and provider tab must remain available while it runs. The CLI tests use fake page/context objects; they do not sign into or prompt real ChatGPT/Claude accounts. Real provider compatibility and a staging round trip remain mandatory before calling the bridge working.

## Staging bridge revalidation — 2026-11-01

This section supersedes the earlier staging note above that the bridge-state tools had not yet been deployed.

- Project: **Rub Minds Staging** (`tzcuuynmviiuactafpld`), PostgreSQL 17.11, status `ACTIVE_HEALTHY`.
- Edge Function: `rub-minds-mcp`, active version **3**. Its deployed files were read back and compared with the candidate branch sources after the deployment's relative-import path rewrites. The bridge load/save tools, Vault-key fallback, atomic rejoin cleanup and atomic session-termination handler are present.
- New staging migration history entries: `20261101221132_mcp_bridge_state`, `20261101221147_group_task_review_criterion_evidence`, and `20261101221342_restrict_group_task_review_service_role_execute`.
- Bridge-state table verification: RLS enabled; no direct table privileges for `anon` or `authenticated`; `service_role` has the required table permissions. The load/save bridge RPCs are restricted to `service_role`.
- Human task-review RPC verification: `authenticated` can execute it; `anon` and `service_role` cannot. The last permission is enforced by the forward-only revoke migration because the staging project's default function grants differed from the isolated CI database.
- Staging PostgreSQL acceptance: `supabase/tests/mcp_bridge_state.sql` passed. `supabase/tests/group_task_coordination.sql` passed inside an explicit transaction followed by rollback. Post-test checks found zero fixture users, rooms, hosts or MCP sessions and verified the intended permissions remained in place.
- The review/performance advisors are **not clean**: they still report authenticated-callable SECURITY DEFINER functions (including intentionally scoped application RPCs), disabled leaked-password protection, unindexed foreign keys and unused indexes. These remain review items; do not claim a project-wide security-advisor clean bill.

### Remaining acceptance boundary

The local GitHub Actions Supabase stack has passed clean migration rebuild, Vault-only startup, MCP tool discovery, and official SDK session tests on earlier bridge commits; the newest combined PR #59 run is repeating the full stack after the dependency merge. The hosted staging function source and database policy have been verified, but a live HTTP initialize/tools-list call against the hosted staging URL was not completed from this environment.

The Playwright ChatGPT/Claude adapters remain **experimental and unverified against real authenticated provider pages**. Their selector, send, response-stability and navigation checks use fake Playwright pages in CI. A real acceptance round trip still requires the account owner to run the foreground CLI against a disposable staging group, manually authenticate in its dedicated browser profile, and approve each displayed group message with `SEND`. The CLI is not an unattended worker; the laptop, foreground process and provider tab must stay available.

No production Supabase schema, Edge Function, secret, Auth setting, Vercel production alias or production deployment was changed during this revalidation.
