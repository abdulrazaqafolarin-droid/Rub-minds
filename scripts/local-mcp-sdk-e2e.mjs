#!/usr/bin/env node
/**
 * End-to-end interoperability test using the official MCP TypeScript client
 * against the disposable local Supabase Edge Function.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const endpoint = process.env.LOCAL_MCP_ENDPOINT;
const apiUrl = process.env.LOCAL_SUPABASE_URL;
const serviceKey = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;
assert.ok(endpoint && apiUrl && serviceKey, "local MCP endpoint and Supabase service key are required");

const adminHeaders = {
  apikey: serviceKey,
  Authorization: "Bearer " + serviceKey,
  "Content-Type": "application/json",
};
async function request(path, init = {}) {
  const response = await fetch(apiUrl + path, {
    ...init,
    headers: { ...adminHeaders, ...(init.headers || {}) },
  });
  const body = await response.json().catch(() => null);
  assert.ok(response.ok, path + " failed (" + response.status + "): " + JSON.stringify(body));
  return body;
}

const owner = await request("/auth/v1/admin/users", {
  method: "POST",
  body: JSON.stringify({
    email: "rub-minds-official-mcp-owner@example.test",
    password: "Local-CI-Official-MCP-Owner-923!x",
    email_confirm: true,
  }),
});
const rooms = await request("/rest/v1/rooms", {
  method: "POST",
  headers: { Prefer: "return=representation" },
  body: JSON.stringify({
    owner_id: owner.id,
    title: "Official MCP client interoperability",
    objective: "Two official SDK clients join and collaborate in isolated CI",
  }),
});
assert.equal(rooms.length, 1);
const room = rooms[0];
const inviteToken = "e".repeat(64);
const tokenHash = createHash("sha256").update(inviteToken, "utf8").digest("hex");
await request("/rest/v1/room_invites", {
  method: "POST",
  headers: { Prefer: "return=representation" },
  body: JSON.stringify({
    room_id: room.id,
    created_by: owner.id,
    token_hash: tokenHash,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    max_uses: 3,
    uses: 0,
    allow_ai: true,
    max_ai_uses: 3,
    ai_uses: 0,
  }),
});

const first = new Client(
  { name: "rub-minds-ci-ai-one", version: "1.0.0" },
  { versionNegotiation: { mode: "auto" } },
);
const second = new Client(
  { name: "rub-minds-ci-ai-two", version: "1.0.0" },
  { versionNegotiation: { mode: "auto" } },
);
const firstTransport = new StreamableHTTPClientTransport(new URL(endpoint));
const secondTransport = new StreamableHTTPClientTransport(new URL(endpoint));

try {
  await Promise.all([first.connect(firstTransport), second.connect(secondTransport)]);
  assert.equal(first.getProtocolEra(), "modern", "official client must negotiate the 2026 MCP protocol");
  assert.equal(second.getProtocolEra(), "modern", "second official client must negotiate the 2026 MCP protocol");

  const catalog = await first.listTools();
  const names = catalog.tools.map(tool => tool.name);
  assert.ok(names.includes("join_group"), "official client did not discover join_group");
  assert.ok(names.includes("leave_group"), "official client did not discover leave_group");
  assert.ok(names.includes("send_group_message"), "official client did not discover send_group_message");
  assert.ok(names.includes("read_group_messages"), "official client did not discover read_group_messages");

  const [joinOne, joinTwo] = await Promise.all([
    first.callTool({
      name: "join_group",
      arguments: {
        invite_token: inviteToken,
        agent_label: "Official SDK AI one",
        confirm_join: true,
        join_request_key: "a".repeat(64),
      },
    }),
    second.callTool({
      name: "join_group",
      arguments: {
        invite_token: inviteToken,
        agent_label: "Official SDK AI two",
        confirm_join: true,
        join_request_key: "b".repeat(64),
      },
    }),
  ]);
  assert.notEqual(joinOne.isError, true, "official SDK AI one could not join: " + JSON.stringify(joinOne));
  assert.notEqual(joinTwo.isError, true, "official SDK AI two could not join: " + JSON.stringify(joinTwo));
  const one = joinOne.structuredContent;
  const two = joinTwo.structuredContent;
  assert.equal(one?.joined, true);
  assert.equal(two?.joined, true);
  assert.equal(one?.room_id, room.id);
  assert.equal(two?.room_id, room.id);
  assert.ok(typeof one?.session_handle === "string" && /^[a-f0-9]{64}$/i.test(one.session_handle));
  assert.ok(typeof two?.session_handle === "string" && /^[a-f0-9]{64}$/i.test(two.session_handle));
  assert.notEqual(one.participant_id, two.participant_id, "independent clients must have distinct participants");
  assert.notEqual(one.session_handle, two.session_handle, "independent clients must have distinct session handles");

  // Import the original conversation context privately to AI one. AI two must
  // not receive the raw import or participant-private memory.
  const imported = await first.callTool({
    name: "import_session_memory",
    arguments: {
      session_handle: one.session_handle,
      document: {
        schema: "rub-minds.session-memory",
        version: 1,
        summary: "Private source context: prefers concise research and is investigating quantum batteries.",
        current_goal: "Investigate quantum batteries.",
        source: { platform: "ChatGPT", session_label: "AI one source conversation" },
        sharing: { raw_history_visibility: "private" },
      },
    },
  });
  assert.notEqual(imported.isError, true, "official SDK client could not import private session context: " + JSON.stringify(imported));
  assert.equal(imported.structuredContent?.imported, true);
  assert.equal(imported.structuredContent?.visibility, "private");

  const privateEntry = await first.callTool({
    name: "remember_memory",
    arguments: {
      session_handle: one.session_handle,
      entry_type: "insight",
      content: "PRIVATE ONLY: preserve the original user's unpublished research constraint.",
      visibility: "private",
      idempotency_key: "sdk-private-memory-one",
    },
  });
  assert.notEqual(privateEntry.isError, true, "private memory write failed: " + JSON.stringify(privateEntry));
  const groupEntry = await first.callTool({
    name: "remember_memory",
    arguments: {
      session_handle: one.session_handle,
      entry_type: "decision",
      content: "SHARED DECISION: compare quantum battery papers by reproducibility.",
      visibility: "group",
      idempotency_key: "sdk-group-memory-one",
    },
  });
  assert.notEqual(groupEntry.isError, true, "group memory write failed: " + JSON.stringify(groupEntry));

  const [memoryOne, memoryTwo] = await Promise.all([
    first.callTool({
      name: "read_session_memory",
      arguments: { session_handle: one.session_handle },
    }),
    second.callTool({
      name: "read_session_memory",
      arguments: { session_handle: two.session_handle },
    }),
  ]);
  assert.notEqual(memoryOne.isError, true, "AI one could not read its own memory");
  assert.notEqual(memoryTwo.isError, true, "AI two could not read its memory");
  assert.ok(
    memoryOne.structuredContent?.imports?.some(entry => entry.context_summary?.includes("Private source context")),
    "AI one could not read its imported source summary",
  );
  assert.ok(
    memoryTwo.structuredContent?.imports?.length === 0,
    "AI two must not see AI one's imported source context",
  );
  assert.ok(
    memoryOne.structuredContent?.group_memory?.some(entry => entry.visibility === "private" && entry.content.includes("PRIVATE ONLY")),
    "AI one must retain access to its own private memory",
  );
  assert.ok(
    !memoryTwo.structuredContent?.group_memory?.some(entry => entry.content.includes("PRIVATE ONLY")),
    "AI two must not see AI one's private memory",
  );
  assert.ok(
    memoryTwo.structuredContent?.group_memory?.some(entry => entry.visibility === "group" && entry.content.includes("SHARED DECISION")),
    "AI two must see explicitly group-shared memory",
  );
  console.log("Official MCP SDK private session-context and explicit group-memory isolation passed.");

  const sent = await first.callTool({
    name: "send_group_message",
    arguments: {
      session_handle: one.session_handle,
      body: "Official MCP SDK AI one says hello to AI two",
      source_message_id: "official-sdk-e2e-message-one",
    },
  });
  assert.notEqual(sent.isError, true, "official SDK client could not send a group message: " + JSON.stringify(sent));
  const read = await second.callTool({
    name: "read_group_messages",
    arguments: { session_handle: two.session_handle },
  });
  assert.notEqual(read.isError, true, "official SDK client could not read group messages: " + JSON.stringify(read));
  assert.ok(
    read.structuredContent?.messages?.some(message => message.body === "Official MCP SDK AI one says hello to AI two"),
    "second official client did not receive the first client's group message",
  );

  const left = await first.callTool({
    name: "leave_group",
    arguments: { session_handle: one.session_handle, confirm_leave: true },
  });
  assert.notEqual(left.isError, true, "official SDK client could not leave and revoke its session: " + JSON.stringify(left));
  const deniedAfterLeave = await first.callTool({
    name: "read_group_messages",
    arguments: { session_handle: one.session_handle },
  });
  assert.equal(deniedAfterLeave.isError, true, "a revoked session must not keep reading group messages");

  const participants = await request(
    "/rest/v1/participants?select=id,kind&room_id=eq." + room.id + "&kind=eq.external_agent",
  );
  assert.equal(participants.length, 2, "official SDK clients must create exactly two AI participants");
  const connections = await request("/rest/v1/agent_connections?select=id,revoked_at&room_id=eq." + room.id);
  assert.equal(connections.length, 2, "both official SDK clients must have scoped connections");
  assert.ok(connections.some(connection => connection.revoked_at), "leaving must revoke the first AI credential");
  console.log("Official MCP SDK interoperability passed: discovery, tool catalog, two AI joins, shared message relay, and credential revocation.");
} finally {
  await Promise.allSettled([first.close(), second.close()]);
}
