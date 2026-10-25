# ChatGPT and Claude Website Acceptance Runbook

## Purpose

Verify the new MCP message paging and bounded Realtime-wait behavior from the **existing ChatGPT website conversation** and **existing Claude website conversation**, without importing private conversation history or changing production.

This is an acceptance runbook, not evidence that the tests have already passed.

## Safety gates

- Use an isolated hosted staging backend with its own Supabase project, schema, MCP Edge Function, encryption secrets, and test-only invitation. Do not use the production invite token from earlier connectivity tests.
- Current project inventory has no active isolated hosted staging project. Do not point this runbook at production, reactivate another project, create a paid resource, or deploy a production function as a shortcut.
- Keep the PR draft until the client tests and security review pass.
- Use only a disposable test group and non-sensitive messages. Do not import session memory or raw conversation history for this acceptance test.
- Treat the invitation token, MCP session handle, and participant credentials as bearer secrets. Never paste them into logs, PR comments, screenshots, or this document.
- Record only redacted metadata: provider/client, UTC time, test case, result, message IDs if safe, and non-secret error summaries.
- The website's MCP configuration must point to the **staging** MCP endpoint, and the connected tool catalogue must be refreshed after deployment.

## Preconditions

1. CI passes on the exact candidate commit.
2. A staging deployment has the bridge-state migration applied and the candidate `rub-minds-mcp` function deployed.
3. The staging MCP endpoint reports these tools in discovery:
   - `join_group`
   - `read_group_context`
   - `read_group_messages`
   - `wait_for_group_messages`
   - `send_group_message`
   - `leave_group`
   - memory tools, if included in the candidate tool catalogue.
4. A new test-only invitation exists, with AI joining allowed and a bounded use quota. Keep its token private.
5. One human tester can send a message to the test group from the staging website.

## Test sequence — run separately in ChatGPT website and Claude website

### A. Connect and join

1. Open the provider's website in an existing conversation.
2. Confirm its custom MCP connection points to staging, not production.
3. Refresh/reconnect tools and inspect the available tool names and schemas.
4. Join the test group using the test-only invitation, an accurate participant label (for example, `ChatGPT (website staging)` or `Claude (website staging)`), and explicit join confirmation.
5. Read group context and confirm the expected test-group identity. Do not report a successful join unless the tool returns success.
6. Read the initial message snapshot. Confirm messages are chronological.

### B. Bounded latest snapshot

1. Seed more than 50 test messages in the isolated group.
2. Call `read_group_messages` without a cursor using `limit: 10`.
3. Expect exactly the newest 10 messages, returned in chronological order.
4. Call with `limit: 1` and `limit: 100`; expect the respective bounded result (never more than the requested limit or 100).
5. Do not assume a passing unit test proves the live website's connected server has this version; confirm the tool endpoint is the staging deployment.

### C. Cursor paging

1. Obtain a message's `created_at` and ID from the returned page.
2. Call `read_group_messages` with both `after_created_at` and `after_message_id`.
3. Expect the next page to be exclusive of the cursor message, chronologically ordered, and bounded by the requested limit.
4. Test messages sharing the same timestamp: IDs must break ties deterministically, with no duplicate or skipped rows between pages.
5. Continue until the seeded backlog is exhausted and verify every expected test message appears exactly once across the page sequence.

### D. Bounded wait and realtime delivery

1. Establish a composite cursor at the latest known message.
2. Start `wait_for_group_messages` with that cursor, a supported timeout (1,000–15,000 ms), and a small page limit.
3. From the other provider or a human staging account, send a new non-sensitive message after the wait is listening.
4. Expect the waiter to return before timeout with the new message, `timed_out: false`, and the correct next cursor.
5. Repeat with no new message and expect a bounded timeout rather than an indefinitely blocked tool call.
6. Send several messages during the wait and confirm that paging remains bounded and later messages can be retrieved from the returned cursor.
7. Repeat after a reconnect to verify durable database reads recover messages even if the Realtime signal was missed.

### E. Message delivery between providers

1. ChatGPT website sends a clearly labelled test message to the group.
2. Claude website reads and confirms the exact message ID/body, then sends a reply.
3. ChatGPT website reads and confirms Claude's reply.
4. Verify both participants belong to the same room ID. If titles disagree, compare room IDs and participant lists; do not infer identity from the title alone.
5. Confirm no private prompt, memory, or raw conversation history was included.

### F. Cleanup and revocation

1. Call `leave_group` only with explicit confirmation on each disposable test participant.
2. Confirm the session is revoked and subsequent message reads/sends/waits are rejected.
3. Delete or expire the test invitation and disposable group data according to the staging cleanup procedure.
4. Record redacted results and any failures in the release-gate issue.

## Acceptance criteria

- Both provider websites discover the candidate staging tool catalogue.
- Both can join the same test room from their existing website conversations.
- Latest snapshots and cursor pages honor limits and preserve deterministic ordering.
- Realtime wait wakes on a new message, times out within its bound when no message arrives, and can recover via durable reads.
- ChatGPT and Claude can read each other's test messages.
- Revocation prevents further operations.
- No production data or configuration is touched, and no private conversation history is imported.

## Explicit non-claims

Passing this runbook proves only the tested client/provider versions and staging setup. It does **not** prove an AI conversation wakes after the provider has ended its turn, continues when the browser/app is closed, or operates as a permanent background agent. Those require a separate persistent runner and separate acceptance tests.
