import test from "node:test";
import assert from "node:assert/strict";
import {
  MCP_PROTOCOL_VERSION,
  MCP_MODERN_PROTOCOL_VERSION,
  getModernMcpTools,
  validateModernRequestMetadata,
  RUB_MINDS_MCP_TOOLS,
  rpcError,
  rpcResult,
  validateSessionMemoryDocument,
  validateToolArguments,
  filterMessagesAfterCursor,
  isAllowedMcpOrigin,
  validateProtocolVersionHeader,
  applyMcpCors,
  isJsonContentType,
} from "./protocol.mjs";


test("current stateless protocol exposes explicit session handles and retry keys", () => {
  assert.equal(MCP_MODERN_PROTOCOL_VERSION, "2026-07-28");
  const tools = getModernMcpTools();
  const join = tools.find((tool) => tool.name === "join_group");
  assert.ok(join);
  assert.ok(join.inputSchema.required.includes("join_request_key"));
  assert.equal(join.inputSchema.properties.join_request_key.pattern, "^[a-fA-F0-9]{64}$");
  for (const tool of tools.filter((item) => item.name !== "join_group")) {
    assert.ok(tool.inputSchema.required.includes("session_handle"), tool.name);
    assert.equal(tool.inputSchema.properties.session_handle.pattern, "^[a-fA-F0-9]{64}$");
  }
  assert.ok(RUB_MINDS_MCP_TOOLS.find((tool) => tool.name === "join_group").inputSchema.properties.join_request_key === undefined);
});

test("current stateless protocol validates request metadata and mirrored headers", () => {
  const meta = { _meta: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
  } };
  assert.equal(validateModernRequestMetadata("tools/list", { protocolVersion: "2026-07-28", method: "tools/list" }, meta), null);
  assert.equal(validateModernRequestMetadata("tools/list", { protocolVersion: "2026-07-28", method: "tools/call" }, meta).code, -32020);
  assert.equal(validateModernRequestMetadata("tools/list", { protocolVersion: "2026-07-28", method: "tools/list" }, { _meta: { ...meta._meta, "io.modelcontextprotocol/protocolVersion": "2025-11-25" } }).code, -32020);
  assert.equal(validateModernRequestMetadata("tools/list", { protocolVersion: "2025-11-25", method: "tools/list" }, { _meta: { ...meta._meta, "io.modelcontextprotocol/protocolVersion": "2025-11-25" } }).code, -32022);
  assert.equal(validateModernRequestMetadata("tools/call", { protocolVersion: "2026-07-28", method: "tools/call", name: "read_group_context" }, { ...meta, name: "read_group_messages" }).code, -32020);
  assert.equal(validateModernRequestMetadata("tools/list", { protocolVersion: "2026-07-28", method: "tools/list" }, { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } }).code, -32602);
});

test("advertises invitation, messaging, and memory tools", () => {
  assert.equal(MCP_PROTOCOL_VERSION, "2025-06-18");
  assert.deepEqual(RUB_MINDS_MCP_TOOLS.map((tool) => tool.name), [
    "join_group", "leave_group", "read_group_context", "read_group_messages", "wait_for_group_messages", "send_group_message",
    "read_session_memory", "import_session_memory", "remember_memory",
  ]);
});

test("transport validates negotiated protocol version and supplied origins", () => {
  assert.equal(validateProtocolVersionHeader("initialize", null), null);
  assert.equal(validateProtocolVersionHeader("tools/list", MCP_PROTOCOL_VERSION), null);
  assert.match(validateProtocolVersionHeader("tools/list", null), /MCP-Protocol-Version/);
  assert.equal(isAllowedMcpOrigin(null), true);
  assert.equal(isAllowedMcpOrigin("https://chatgpt.com"), true);
  assert.equal(isAllowedMcpOrigin("https://claude.ai"), true);
  assert.equal(isAllowedMcpOrigin("https://attacker.example"), false);
});

test("CORS exposes the MCP session capability only to allowed browser origins", async () => {
  const preflight = new Response(null, { status: 204, headers: {
    "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, mcp-session-id, mcp-protocol-version, mcp-method, mcp-name, accept",
  } });
  const allowed = applyMcpCors(preflight, "https://chatgpt.com");
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), "https://chatgpt.com");
  assert.equal(allowed.headers.get("Access-Control-Expose-Headers"), "Mcp-Session-Id");
  assert.equal(allowed.headers.get("Vary"), "Origin");
  const blocked = applyMcpCors(new Response("blocked"), "https://attacker.example");
  assert.equal(blocked.headers.get("Access-Control-Allow-Origin"), null);
  const serverToServer = applyMcpCors(new Response("ok"), null);
  assert.equal(serverToServer.headers.get("Access-Control-Allow-Origin"), null);
});

test("HTTP transport accepts only JSON request content types", () => {
  assert.equal(isJsonContentType("application/json"), true);
  assert.equal(isJsonContentType("Application/JSON; charset=utf-8"), true);
  assert.equal(isJsonContentType("text/plain"), false);
  assert.equal(isJsonContentType(null), false);
});

test("join requires a valid invitation and explicit confirmation", () => {
  const token = "a".repeat(64);
  assert.equal(validateToolArguments("join_group", { invite_token: token, agent_label: "Claude", confirm_join: true }), null);
  assert.match(validateToolArguments("join_group", { invite_token: token, agent_label: "Claude" }), /confirmation/);
  assert.match(validateToolArguments("join_group", { invite_token: "short", agent_label: "Claude", confirm_join: true }), /token/);
  assert.match(validateToolArguments("join_group", { invite_token: token, agent_label: " ", confirm_join: true }), /agent_label/);
  assert.match(validateToolArguments("join_group", { invite_token: token, agent_label: "Claude", confirm_join: true, credential: "leak" }), /Unknown/);
});

test("leave_group requires explicit confirmation and rejects unknown arguments", () => {
  assert.equal(validateToolArguments("leave_group", { confirm_leave: true }), null);
  assert.match(validateToolArguments("leave_group", {}), /confirmation/);
  assert.match(validateToolArguments("leave_group", { confirm_leave: true, force: true }), /Unknown/);
});

test("Realtime wait tool validates an exclusive composite cursor and bounds its wait", () => {
  assert.equal(validateToolArguments("wait_for_group_messages", {}), null);
  assert.equal(validateToolArguments("wait_for_group_messages", {
    after_created_at: "2026-10-24T17:00:00.000Z", timeout_ms: 5000,
  }), null); // Legacy timestamp-only callers remain supported.
  assert.equal(validateToolArguments("wait_for_group_messages", {
    after_created_at: "2026-10-24T17:00:00.000Z", after_message_id: "message-42", timeout_ms: 5000,
  }), null);
  assert.match(validateToolArguments("wait_for_group_messages", { after_created_at: "not-a-date" }), /date-time/);
  assert.match(validateToolArguments("wait_for_group_messages", { after_message_id: "message-42" }), /requires after_created_at/);
  assert.match(validateToolArguments("wait_for_group_messages", {
    after_created_at: "2026-10-24T17:00:00.000Z", after_message_id: "   ",
  }), /non-empty/);
  assert.match(validateToolArguments("wait_for_group_messages", {
    after_created_at: "2026-10-24T17:00:00.000Z", after_message_id: "x".repeat(201),
  }), /200 characters/);
  assert.match(validateToolArguments("wait_for_group_messages", { timeout_ms: 999 }), /1000 to 15000/);
  assert.match(validateToolArguments("wait_for_group_messages", { timeout_ms: 15001 }), /1000 to 15000/);
  assert.match(validateToolArguments("wait_for_group_messages", { extra: true }), /Unknown/);
});

test("composite message cursor excludes the last message and preserves timestamp ties", () => {
  const sameTime = "2026-10-24T17:00:00.123456+00:00";
  const afterTime = "2026-10-24T17:00:00.123457+00:00";
  const data = { messages: [
    { id: "00000000-0000-0000-0000-000000000001", created_at: "2026-10-24T17:00:00.123455+00:00", body: "older" },
    { id: "00000000-0000-0000-0000-000000000040", created_at: sameTime, body: "cursor" },
    { id: "00000000-0000-0000-0000-000000000041", created_at: sameTime, body: "same timestamp, later id" },
    { id: "00000000-0000-0000-0000-000000000001", created_at: afterTime, body: "later timestamp, any id" },
    { id: "bad", created_at: "not a timestamp", body: "invalid" },
    null,
  ] };
  const result = filterMessagesAfterCursor(data, {
    afterCreatedAt: sameTime,
    afterMessageId: "00000000-0000-0000-0000-000000000040",
  });
  assert.deepEqual(result.map(message => message.body), [
    "same timestamp, later id",
    "later timestamp, any id",
  ]);
});

test("timestamp-only cursors remain inclusive for older MCP clients", () => {
  const stamp = "2026-10-24T17:00:00.000Z";
  const result = filterMessagesAfterCursor({ messages: [
    { id: "before", created_at: "2026-10-24T16:59:59.999Z" },
    { id: "at", created_at: stamp },
    { id: "after", created_at: "2026-10-24T17:00:00.001Z" },
  ] }, { afterCreatedAt: stamp });
  assert.deepEqual(result.map(message => message.id), ["at", "after"]);
});

test("message cursor filtering handles malformed input and missing cursor", () => {
  assert.deepEqual(filterMessagesAfterCursor(null, { afterCreatedAt: null, now: 0 }), []);
  assert.deepEqual(filterMessagesAfterCursor({ messages: "not an array" }, { afterCreatedAt: null, now: 0 }), []);
  assert.deepEqual(filterMessagesAfterCursor({ messages: [
    { id: "future", created_at: "1970-01-01T00:00:00.001Z" },
    { id: "past", created_at: "1969-12-31T23:59:59.999Z" },
  ] }, { afterCreatedAt: null, now: 0 }).map(message => message.id), ["future"]);
});

test("message tool rejects empty, oversized, and unknown arguments", () => {
  assert.equal(validateToolArguments("read_group_context", {}), null);
  assert.match(validateToolArguments("read_group_context", { room_id: "injected" }), /arguments/);
  assert.equal(validateToolArguments("send_group_message", { body: "hello" }), null);
  assert.match(validateToolArguments("send_group_message", { body: " " }), /body/);
  assert.match(validateToolArguments("send_group_message", { body: "x".repeat(10001) }), /body/);
  assert.match(validateToolArguments("send_group_message", { body: "hello", admin: true }), /Unknown/);
});

test("session memory requires a strict private packet schema and bounded fields", () => {
  const valid = { schema: "rub-minds.session-memory", version: 1, summary: "summary", current_goal: "goal", source: { platform: "ChatGPT" }, sharing: { raw_history_visibility: "private" } };
  assert.equal(validateSessionMemoryDocument(valid), true);
  assert.equal(validateSessionMemoryDocument({ ...valid, sharing: { raw_history_visibility: "group" } }), false);
  assert.equal(validateSessionMemoryDocument({ ...valid, sharing: undefined }), false);
  assert.equal(validateSessionMemoryDocument({ ...valid, source: { platform: "ChatGPT", session_label: 200 } }), false);
  assert.equal(validateSessionMemoryDocument({ ...valid, source: { platform: " " } }), false);
  assert.equal(validateSessionMemoryDocument({ ...valid, unexpected_private_payload: "do not persist unknown fields" }), false);
  assert.equal(validateSessionMemoryDocument({ ...valid, version: 2 }), false);
  assert.equal(validateSessionMemoryDocument({ ...valid, summary: " " }), false);
  assert.equal(validateSessionMemoryDocument({ ...valid, summary: "x".repeat(20001) }), false);
});

test("memory visibility is explicit and idempotency keys are bounded", () => {
  const args = { entry_type: "decision", content: "Use MCP", visibility: "private", idempotency_key: "decision-001" };
  assert.equal(validateToolArguments("remember_memory", args), null);
  assert.match(validateToolArguments("remember_memory", { ...args, visibility: "all" }), /visibility/);
  assert.match(validateToolArguments("remember_memory", { ...args, idempotency_key: "x" }), /idempotency_key/);
  assert.match(validateToolArguments("remember_memory", { ...args, idempotency_key: "        " }), /idempotency_key/);
  const sourceId = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(validateToolArguments("remember_memory", { ...args, source_message_ids: [sourceId] }), null);
  assert.match(validateToolArguments("remember_memory", { ...args, source_message_ids: [sourceId, sourceId] }), /unique UUIDs/);
});

test("JSON-RPC helpers preserve request ids and error codes", () => {
  assert.deepEqual(rpcResult("abc", { ok: true }), { jsonrpc: "2.0", id: "abc", result: { ok: true } });
  assert.deepEqual(rpcError(2, -32601, "Method not found"), { jsonrpc: "2.0", id: 2, error: { code: -32601, message: "Method not found" } });
});


test("wait tool explains active-turn monitoring and the idle wake limitation", () => {
  const tool = RUB_MINDS_MCP_TOOLS.find((item) => item.name === "wait_for_group_messages");
  assert.ok(tool);
  assert.match(tool.description, /repeat this tool/);
  assert.match(tool.description, /after_created_at and after_message_id/);
  assert.match(tool.description, /cursor is exclusive/);
  assert.match(tool.description, /cannot wake an idle model/);
  assert.match(tool.description, /host keeps the turn active/);
});
