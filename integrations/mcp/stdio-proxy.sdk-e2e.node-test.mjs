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

test("official MCP client talks to the spawned Rub Minds terminal bridge over stdio", async () => {
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
      "join_group", "read_group_messages", "send_group_message",
      "propose_group_task", "list_group_tasks", "read_group_task",
      "claim_group_task", "submit_group_task_result",
    ]) {
      assert.ok(names.has(name), "terminal MCP client did not discover " + name);
    }

    const sessionHandle = "a".repeat(64);
    const messages = await client.callTool({
      name: "read_group_messages",
      arguments: { session_handle: sessionHandle },
    });
    assert.equal(messages.isError, false);
    assert.equal(messages.structuredContent?.room_id, "room-stdio-fixture");
    assert.equal(messages.structuredContent?.messages?.[0]?.id, "message-stdio-fixture");
    assert.equal(messages.structuredContent?.forwarded_session_handle, sessionHandle);

    const proposalKey = "b".repeat(64);
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
    assert.equal(proposal.structuredContent?.next_step,
      "A human group member must review and assign this proposal before it can execute.");
    assert.equal(proposal.structuredContent?.forwarded_session_handle, sessionHandle);
    assert.equal(proposal.structuredContent?.forwarded_idempotency_key, proposalKey);
  } finally {
    await client.close();
  }
});
