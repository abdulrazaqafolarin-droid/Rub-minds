import test from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = resolve(root, "scripts/rub-minds-mcp.mjs");
const fixture = pathToFileURL(resolve(root, "integrations/mcp/stdio-proxy-test-upstream.mjs")).href;
const endpoint = "https://tzcuuynmviiuactafpld.supabase.co/functions/v1/rub-minds-mcp";

test("official MCP client completes a terminal group and human-governed task workflow over stdio", async () => {
  const env = {
    ...process.env,
    RUB_MINDS_MCP_ENDPOINT: endpoint,
    RUB_MINDS_MCP_API_KEY: "rub-minds-public-test-key",
    RUB_MINDS_STDIO_E2E_FIXTURE: "1",
    NODE_OPTIONS: [process.env.NODE_OPTIONS, "--import=" + fixture].filter(Boolean).join(" "),
  };
  const client = new Client(
    { name: "rub-minds-terminal-stdio-e2e", version: "1.0.0" },
    { versionNegotiation: { mode: "legacy" } },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "--stdio"],
    cwd: root,
    env,
  });

  try {
    await client.connect(transport);

    const catalog = await client.listTools();
    const names = new Set(catalog.tools.map(tool => tool.name));
    for (const name of [
      "join_group", "leave_group", "read_group_messages", "send_group_message",
      "propose_group_task", "list_group_tasks", "read_group_task",
      "claim_group_task", "submit_group_task_result",
    ]) {
      assert.ok(names.has(name), "terminal MCP client did not discover " + name);
    }

    let unconfirmedJoinError = null;
    try {
      await client.callTool({
        name: "join_group",
        arguments: {
          invite_token: "c".repeat(64),
          agent_label: "Unconfirmed terminal AI",
          confirm_join: false,
          join_request_key: "f".repeat(64),
        },
      });
    } catch (error) {
      unconfirmedJoinError = error;
    }
    assert.equal(unconfirmedJoinError?.code, -32602,
      "join_group must reject a request without explicit confirmation at the MCP protocol layer");

    const joined = await client.callTool({
      name: "join_group",
      arguments: {
        invite_token: "c".repeat(64),
        agent_label: "Local terminal AI",
        confirm_join: true,
        join_request_key: "d".repeat(64),
      },
    });
    assert.equal(joined.isError, false, "explicitly confirmed terminal AI could not join");
    assert.equal(joined.structuredContent?.joined, true);
    assert.match(joined.structuredContent?.room_id, /^[0-9a-f-]{36}$/i);
    assert.match(joined.structuredContent?.participant_id, /^[0-9a-f-]{36}$/i);
    const sessionHandle = joined.structuredContent?.session_handle;
    assert.match(sessionHandle, /^[a-f0-9]{64}$/i);

    const messages = await client.callTool({
      name: "read_group_messages",
      arguments: { session_handle: sessionHandle },
    });
    assert.equal(messages.isError, false);
    assert.match(messages.structuredContent?.room_id, /^[0-9a-f-]{36}$/i);
    assert.match(messages.structuredContent?.messages?.[0]?.id, /^[0-9a-f-]{36}$/i);
    assert.equal(messages.structuredContent?.forwarded_session_handle, sessionHandle);

    const sent = await client.callTool({
      name: "send_group_message",
      arguments: {
        session_handle: sessionHandle,
        body: "Terminal AI connected and can participate in the Rub Minds group.",
      },
    });
    assert.equal(sent.isError, false);
    assert.equal(sent.structuredContent?.sent, true);
    assert.equal(sent.structuredContent?.message?.body,
      "Terminal AI connected and can participate in the Rub Minds group.");
    assert.equal(sent.structuredContent?.forwarded_session_handle, sessionHandle);

    const proposalKey = "77777777-7777-4777-8777-777777777777";
    const proposal = await client.callTool({
      name: "propose_group_task",
      arguments: {
        session_handle: sessionHandle,
        title: "Inspect the live Windows frame identity",
        description: "Verify that app, process and window identity remain bound.",
        expected_output: "A reproducible Windows identity acceptance report.",
        acceptance_criteria: ["The active HWND is exact", "Monitor geometry matches the same HWND"],
        priority: 2,
        idempotency_key: proposalKey,
      },
    });
    assert.equal(proposal.isError, false);
    assert.equal(proposal.structuredContent?.proposed, true);
    assert.equal(proposal.structuredContent?.task?.status, "proposed");
    assert.equal(proposal.structuredContent?.task?.assigned_to_participant_id, null);
    assert.equal(proposal.structuredContent?.next_step,
      "A human group member must review and assign this proposal before it can execute.");
    assert.equal(proposal.structuredContent?.forwarded_session_handle, sessionHandle);
    assert.equal(proposal.structuredContent?.forwarded_idempotency_key, proposalKey);

    const tasks = await client.callTool({
      name: "list_group_tasks",
      arguments: { session_handle: sessionHandle },
    });
    assert.equal(tasks.isError, false);
    assert.ok(tasks.structuredContent?.tasks?.some(task => task.id === proposal.structuredContent.task.id));
    assert.ok(tasks.structuredContent?.tasks?.some(task => task.id === "44444444-4444-4444-8444-444444444444"));

    const proposedRead = await client.callTool({
      name: "read_group_task",
      arguments: { session_handle: sessionHandle, task_id: proposal.structuredContent.task.id },
    });
    assert.equal(proposedRead.isError, false);
    assert.equal(proposedRead.structuredContent?.task?.status, "proposed");

    const forbiddenClaim = await client.callTool({
      name: "claim_group_task",
      arguments: { session_handle: sessionHandle, task_id: proposal.structuredContent.task.id },
    });
    assert.equal(forbiddenClaim.isError, true, "unassigned task proposal must not be claimable");
    assert.equal(forbiddenClaim.structuredContent?.claimed, false);

    // The fixture models a separate human group-member assignment. It does not
    // allow the AI participant to approve or assign its own proposed task.
    const assignedTask = await client.callTool({
      name: "read_group_task",
      arguments: { session_handle: sessionHandle, task_id: "44444444-4444-4444-8444-444444444444" },
    });
    assert.equal(assignedTask.isError, false);
    assert.equal(assignedTask.structuredContent?.task?.status, "assigned");
    assert.equal(assignedTask.structuredContent?.task?.assigned_to_participant_id,
      joined.structuredContent.participant_id);

    const claimed = await client.callTool({
      name: "claim_group_task",
      arguments: { session_handle: sessionHandle, task_id: "task-human-assigned-fixture" },
    });
    assert.equal(claimed.isError, false);
    assert.equal(claimed.structuredContent?.claimed, true);
    assert.equal(claimed.structuredContent?.status, "in_progress");

    const submitted = await client.callTool({
      name: "submit_group_task_result",
      arguments: {
        session_handle: sessionHandle,
        task_id: "task-human-assigned-fixture",
        result: "The selected Backroom-launched app HWND was checked against process and monitor bounds.",
        submission_key: "88888888-8888-4888-8888-888888888888",
      },
    });
    assert.equal(submitted.isError, false);
    assert.equal(submitted.structuredContent?.submitted, true);
    assert.equal(submitted.structuredContent?.status, "submitted");
    let unconfirmedLeaveError = null;
    try {
      await client.callTool({
        name: "leave_group",
        arguments: { session_handle: sessionHandle, confirm_leave: false },
      });
    } catch (error) {
      unconfirmedLeaveError = error;
    }
    assert.equal(unconfirmedLeaveError?.code, -32602,
      "leave_group must reject a request without explicit confirmation at the MCP protocol layer");

    const left = await client.callTool({
      name: "leave_group",
      arguments: { session_handle: sessionHandle, confirm_leave: true },
    });
    assert.equal(left.isError, false);
    assert.equal(left.structuredContent?.left, true);

    const afterLeaveRead = await client.callTool({
      name: "read_group_messages",
      arguments: { session_handle: sessionHandle },
    });
    assert.equal(afterLeaveRead.isError, true,
      "a revoked terminal group session must no longer read group messages");

  } finally {
    await client.close();
  }
});
