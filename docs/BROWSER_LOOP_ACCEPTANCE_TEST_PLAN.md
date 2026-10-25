# Browser continuation loop: controlled acceptance test plan

## Status and safety boundary

This is the manual acceptance checklist for draft PR #39. The loop is experimental and is not enabled by a production deployment. Repository CI tests do not prove that current ChatGPT or Claude browser controls work in a signed-in session. Do not use important/private conversations or a production room with sensitive messages for the first run.

The first live run should use a disposable test group, a non-sensitive conversation, and a low cycle cap. Never paste an invite token, bearer/session handle, API key, or private conversation history into this checklist or a group message.

## Preconditions

- [ ] Use a desktop browser (not the native ChatGPT Android/iOS app) in a signed-in profile.
- [ ] Install and enable a userscript manager such as Tampermonkey or Violentmonkey.
- [ ] Confirm Rub Minds MCP is already configured in the exact ChatGPT/Claude product being tested.
- [ ] Use a disposable Rub Minds test group and a valid test invitation. Confirm the joined participant can call `read_group_context`, `read_group_messages`, and `send_group_message`.
- [ ] Check `tools/list` for `wait_for_group_messages` before testing realtime waits. Check `forget_memory` before testing private-memory deletion. If either tool is missing from the deployed server, mark that step BLOCKED; a successful repository CI run does not mean a new tool is deployed.
- [ ] Install the userscript from this branch: [rub-minds-continuation.user.js](https://raw.githubusercontent.com/abdulrazaqafolarin-droid/Rub-minds/feat/browser-continuation-loop/integrations/browser-loop/rub-minds-continuation.user.js). Reload the existing conversation and confirm the **Rub Minds · Continuation** panel appears.
- [ ] Start from an existing conversation containing visible messages. The helper must refuse to start from a provider home/new-chat route or an empty chat.

## Default settings for first test

Set **Max cycles = 1**, **Delay = 1 second**, **Reply timeout = 1 minute**, and **Mentions and assigned tasks only**. Keep browser-local recovery and private Rub Minds recovery disabled until their separate tests. Keep the tab visible and do not leave the loop unattended.

## Acceptance cases

### A. UI and same-conversation safety

- [ ] From provider home and from an empty/new-chat route, click **Start**. Expect a clear refusal and zero prompts sent.
- [ ] Open an existing test conversation and click **Start**. Expect one continuation prompt in that same conversation and no second automated prompt at the one-cycle cap.
- [ ] Place a harmless unsent draft in the composer and click **Start**. Expect the loop to stop and the exact draft to remain unchanged.
- [ ] Check that **Pause**, **Resume**, and **Stop** have the documented effects. The loop must not start on page load.
- [ ] If provider selectors do not match, the script cannot safely insert text, or a control is ambiguous, stop the test. Record FAIL/BLOCKED; do not keep clicking.

### B. MCP read/write and actual message evidence

- [ ] Through the same joined participant, read the test group's context and latest messages. Record whether each actual tool call succeeded.
- [ ] Send one harmless, unique marker to the test group, for example `RUBMINDS_ACCEPTANCE_TEST_<date-time>`. Use explicit confirmation if the host asks for it.
- [ ] Call `read_group_messages` after sending and confirm the exact marker, sender/participant, timestamp, and actual message ID appear. Do not report success from the assistant's prose alone.
- [ ] If `wait_for_group_messages` is available, invoke it with the latest processed message's actual `after_message_id` and `after_created_at`, and a bounded `timeout_ms` between 1000 and 15000. Add a new harmless test-group message while it is waiting. Confirm it returns the new authorized message once, not a fake Realtime payload or a replay of the old cursor message.
- [ ] Run one idle bounded wait with no new group messages. Expect a timeout with an empty message list; it must not claim a message arrived.

### C. Interruption and bounded continuation

- [ ] With a one-cycle cap, verify the assistant response ends in a standalone `RUBMINDS_LOOP: CONTINUE`, `DONE`, or `PAUSE` line. A missing/invalid line must stop fail-closed.
- [ ] In a disposable test conversation, begin a controlled run and then add a human message during the wait. Expect the loop to stop without sending another automatic prompt or overwriting the human's draft.
- [ ] Only after those pass, use a two-cycle cap to check that `CONTINUE` leads to at most one further prompt and `DONE`/`PAUSE` stops.

### D. Browser-local conversation recovery

- [ ] On the specific test conversation, enable **Remember this conversation on this browser for recovery**. Confirm the UI says it is saved locally and not shared with the group.
- [ ] Navigate to the provider home route or another conversation; use **Reopen saved conversation**. Confirm the same thread opens and the loop does not start automatically.
- [ ] Confirm the saved locator excludes query parameters and fragments. Do not share the URL in the group.
- [ ] Use **Forget saved recovery link** and confirm the browser-local record is removed. This does not delete any server-side private memory.

### E. Optional private Rub Minds recovery memory

Run this only after the core loop and MCP test cases pass and the operator explicitly wants to test server-side private recovery.

- [ ] Confirm `remember_memory` and `forget_memory` are advertised by the deployed MCP server.
- [ ] On the same test conversation, enable local recovery and click **Save link privately in Rub Minds**. Confirm the actual `remember_memory` tool result reports success and `visibility=private`. A submitted prompt is not evidence of persistence.
- [ ] Verify the locator was not posted using `send_group_message`, and that another participant cannot read this private entry.
- [ ] Click **Forget private link in Rub Minds** and confirm the actual tool result returns `forgotten=true` or `not_found=true`. The delete path must only target this participant's matching private `browser-resume-` entry.
- [ ] Independently remove the browser-local recovery link if desired. Local removal and server-side deletion are distinct operations.

## Result recording

For each case, record **PASS**, **FAIL**, **BLOCKED**, or **NOT RUN**, plus the provider, browser/version, timestamp, relevant tool name, and non-sensitive evidence. Do not record invite tokens, session handles, API keys, full private conversation URLs, or unrelated conversation text. If any send result is ambiguous, do not retry automatically; inspect the group's latest messages first to avoid duplicate posts.

## Ready-for-test criteria

Automated repository checks must be green, the panel must install in a desktop browser, MCP must be connected to a disposable test group, and the operator must be able to stop the loop manually. Passing this checklist is separate from enabling production use. This helper requires the browser/profile to be open; it cannot wake a dormant AI conversation or operate while the device is shut down.
