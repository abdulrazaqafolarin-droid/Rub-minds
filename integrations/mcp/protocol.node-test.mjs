import test from "node:test";
import assert from "node:assert/strict";
import {
  messagesAfterCursor,
  compareMessageCursors,
  isValidMessageCursor,
  MCP_PROTOCOL_VERSION,
  MCP_MODERN_PROTOCOL_VERSION,
  getModernMcpTools,
  validateModernRequestMetadata,
  RUB_MINDS_MCP_TOOLS,
  rpcError,
  rpcResult,
  validateSessionMemoryDocument,
  validateToolArguments,
  isAllowedMcpOrigin,
  validateProtocolVersionHeader,
  applyMcpCors,
  isJsonContentType,
  SESSION_EXPORT_INSTRUCTIONS,
  MCP_DISCOVERY_INSTRUCTIONS,
} from "./protocol.mjs";


test("current stateless protocol exposes explicit session handles and retry keys", () => {
  assert.equal(MCP_MODERN_PROTOCOL_VERSION, "2026-07-28");
  const tools = getModernMcpTools();
  const join = tools.find((tool) => tool.name === "join_group");
  assert.ok(join);
  assert.ok(join.inputSchema.required.includes("join_request_key"));
  assert.equal(join.inputSchema.properties.join_request_key.pattern, "^[a-fA-F0-9]{64}$");
  assert.equal(join.inputSchema.properties.session_handle.pattern, "^[a-fA-F0-9]{64}$");
  assert.equal(join.inputSchema.required.includes("session_handle"), false,
    "session_handle is optional because first-time joins must derive a fresh handle");
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
    "join_group", "prepare_session_export", "leave_group", "read_group_context", "read_group_messages", "read_group_message", "wait_for_group_messages", "send_group_message",
    "load_original_session_bridge_state", "save_original_session_bridge_state",
    "read_session_memory", "import_session_memory", "remember_memory", "forget_memory",
    "propose_group_task", "list_group_tasks", "read_group_task", "claim_group_task", "block_group_task", "fail_group_task", "submit_group_task_result",
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
  const base = { invite_token: token, agent_label: "Claude", confirm_join: true };
  assert.equal(validateToolArguments("join_group", base), null,
    "legacy join arguments remain valid");
  assert.equal(validateToolArguments("join_group", { ...base, join_request_key: "b".repeat(64) }), null,
    "modern idempotent joins accept a valid request key");
  assert.equal(validateToolArguments("join_group", {
    ...base, join_request_key: "b".repeat(64), session_handle: "c".repeat(64),
  }), null, "rebind calls accept the existing session handle and fresh request key");
  assert.match(validateToolArguments("join_group", { ...base, join_request_key: "invalid" }), /64-character hexadecimal idempotency key/);
  assert.match(validateToolArguments("join_group", { ...base, session_handle: "invalid" }), /64-character hexadecimal handle/);
  assert.match(validateToolArguments("join_group", { ...base, join_request_key: "b".repeat(64), credential: "leak" }), /Unknown/);
  assert.match(validateToolArguments("join_group", { invite_token: token, agent_label: "Claude" }), /confirmation/);
  assert.match(validateToolArguments("join_group", { invite_token: "short", agent_label: "Claude", confirm_join: true }), /token/);
  assert.match(validateToolArguments("join_group", { invite_token: token, agent_label: " ", confirm_join: true }), /agent_label/);
});

test("leave_group requires explicit confirmation and rejects unknown arguments", () => {
  assert.equal(validateToolArguments("leave_group", { confirm_leave: true }), null);
  assert.match(validateToolArguments("leave_group", {}), /confirmation/);
  assert.match(validateToolArguments("leave_group", { confirm_leave: true, force: true }), /Unknown/);
});

test("Realtime wait tool validates complete composite cursors and bounds its wait", () => {
  const cursorId = "550e8400-e29b-41d4-a716-446655440000";
  const timestamp = "2026-10-24T17:00:00.123456Z";
  assert.equal(validateToolArguments("wait_for_group_messages", {}), null);
  assert.equal(validateToolArguments("wait_for_group_messages", { timeout_ms: 5000 }), null);
  assert.equal(validateToolArguments("wait_for_group_messages", {
    after_message_id: cursorId, after_created_at: timestamp, timeout_ms: 5000,
  }), null);
  assert.match(validateToolArguments("wait_for_group_messages", {
    after_message_id: cursorId, timeout_ms: 5000,
  }), /supplied together/);
  assert.match(validateToolArguments("wait_for_group_messages", {
    after_created_at: timestamp, timeout_ms: 5000,
  }), /supplied together/);
  assert.match(validateToolArguments("wait_for_group_messages", {
    after_message_id: "not-a-uuid", after_created_at: timestamp,
  }), /UUID/);
  assert.match(validateToolArguments("wait_for_group_messages", {
    after_message_id: cursorId, after_created_at: "2026-10-24 17:00:00",
  }), /date-time/);
  assert.match(validateToolArguments("wait_for_group_messages", {
    after_message_id: cursorId, after_created_at: "2026-10-24T17:00:00.1234567Z",
  }), /date-time/);
  assert.match(validateToolArguments("wait_for_group_messages", { timeout_ms: 999 }), /1000 to 15000/);
  assert.match(validateToolArguments("wait_for_group_messages", { timeout_ms: 15001 }), /1000 to 15000/);
  assert.match(validateToolArguments("wait_for_group_messages", { extra: true }), /Unknown/);
});

test("message tool rejects empty, oversized, and unknown arguments", () => {
  assert.equal(validateToolArguments("read_group_context", {}), null);
  assert.match(validateToolArguments("read_group_context", { room_id: "injected" }), /arguments/);
  assert.equal(validateToolArguments("send_group_message", { body: "hello" }), null);
  assert.match(validateToolArguments("send_group_message", { body: " " }), /body/);
  assert.match(validateToolArguments("send_group_message", { body: "x".repeat(10001) }), /body/);
  assert.match(validateToolArguments("send_group_message", { body: "hello", admin: true }), /Unknown/);
});

test("session export is explicit, private, and honestly reports transcript completeness", () => {
  const legacy = RUB_MINDS_MCP_TOOLS.find((tool) => tool.name === "prepare_session_export");
  assert.ok(legacy);
  assert.deepEqual(legacy.inputSchema.required, ["confirm_export"]);
  assert.equal(validateToolArguments("prepare_session_export", { confirm_export: true }), null);
  assert.match(validateToolArguments("prepare_session_export", { confirm_export: false }), /Explicit confirmation/);
  assert.match(validateToolArguments("prepare_session_export", { confirm_export: true, force: true }), /Unknown/);
  const modern = getModernMcpTools().find((tool) => tool.name === "prepare_session_export");
  assert.ok(modern.inputSchema.required.includes("session_handle"));
  assert.match(SESSION_EXPORT_INSTRUCTIONS, /chronological order with speaker labels/);
  assert.ok(SESSION_EXPORT_INSTRUCTIONS.includes("[REDACTED SECRET]"));
  assert.match(SESSION_EXPORT_INSTRUCTIONS, /transcript_complete=false/);
  assert.match(SESSION_EXPORT_INSTRUCTIONS, /Do not send raw transcript content/);
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
  const transcript = { ...valid, transcript_text: "user: Hi\\nassistant: Hello", transcript_complete: false };
  assert.equal(validateSessionMemoryDocument(transcript), true);
  assert.equal(validateSessionMemoryDocument({ ...transcript, transcript_complete: true }), true);
  assert.equal(validateSessionMemoryDocument({ ...valid, transcript_complete: true }), false);
  assert.equal(validateSessionMemoryDocument({ ...valid, transcript_text: 42 }), false);
  assert.equal(validateSessionMemoryDocument({ ...valid, transcript_text: "x".repeat(900001) }), false);
  assert.equal(validateSessionMemoryDocument({ ...transcript, transcript_file_url: "https://attacker.example" }), false);
});

test("memory visibility is explicit and idempotency keys are bounded", () => {
  const args = { entry_type: "decision", content: "Use MCP", visibility: "private", idempotency_key: "decision-001" };
  assert.equal(validateToolArguments("remember_memory", args), null);
  assert.match(validateToolArguments("remember_memory", { ...args, visibility: "all" }), /visibility/);
  assert.match(validateToolArguments("remember_memory", { ...args, idempotency_key: "x" }), /idempotency_key/);
  assert.match(validateToolArguments("remember_memory", { ...args, idempotency_key: "        " }), /idempotency_key/);
  const recoveryPrefix = "Original AI conversation recovery URL (private; do not post to group messages): ";
  assert.equal(validateToolArguments("remember_memory", {
    entry_type: "insight",
    content: recoveryPrefix + "https://chatgpt.com/c/example",
    visibility: "private",
    idempotency_key: "browser-resume-12345678",
  }), null);
  assert.match(validateToolArguments("remember_memory", {
    entry_type: "insight",
    content: "An ordinary private note",
    visibility: "private",
    idempotency_key: "browser-resume-12345678",
  }), /reserved for private browser-recovery locator/);
  assert.match(validateToolArguments("remember_memory", {
    entry_type: "insight",
    content: recoveryPrefix + "https://chatgpt.com/c/example",
    visibility: "group",
    idempotency_key: "browser-resume-12345678",
  }), /reserved for private browser-recovery locator/);
  const sourceId = "550e8400-e29b-41d4-a716-446655440000";
  assert.equal(validateToolArguments("remember_memory", { ...args, source_message_ids: [sourceId] }), null);
  assert.match(validateToolArguments("remember_memory", { ...args, source_message_ids: [sourceId, sourceId] }), /unique UUIDs/);
});

test("forget_memory requires confirmation and accepts only an idempotency key", () => {
  const args = { idempotency_key: "browser-resume-12345678", confirm_forget: true };
  assert.equal(validateToolArguments("forget_memory", args), null);
  assert.match(validateToolArguments("forget_memory", { idempotency_key: args.idempotency_key }), /Explicit confirmation/);
  assert.match(validateToolArguments("forget_memory", { idempotency_key: "browser-resume-x", confirm_forget: true }), /browser-resume key/);
  assert.match(validateToolArguments("forget_memory", { idempotency_key: "sdk-private-memory-one", confirm_forget: true }), /browser-resume key/);
  assert.match(validateToolArguments("forget_memory", { ...args, visibility: "group" }), /Unknown/);
  assert.match(validateToolArguments("forget_memory", {}), /idempotency_key/);
});

test("JSON-RPC helpers preserve request ids and error codes", () => {
  assert.deepEqual(rpcResult("abc", { ok: true }), { jsonrpc: "2.0", id: "abc", result: { ok: true } });
  assert.deepEqual(rpcError(2, -32601, "Method not found"), { jsonrpc: "2.0", id: 2, error: { code: -32601, message: "Method not found" } });
});


test("exact message cursor avoids replay and preserves newer messages with equal timestamps", () => {
  const same = "2026-10-25T10:00:00.000Z";
  const messages = [
    { id: "older", created_at: "2026-10-25T09:59:59.000Z" },
    { id: "cursor", created_at: same },
    { id: "same-time-newer", created_at: same },
    { id: "newer", created_at: "2026-10-25T10:00:01.000Z" },
  ];
  assert.deepEqual(messagesAfterCursor(messages, Date.parse(same), "cursor").map(m => m.id), ["same-time-newer", "newer"]);
});

test("time fallback uses strict greater-than and rejects malformed messages", () => {
  const messages = [
    { id: "equal", created_at: "2026-10-25T10:00:00.000Z" },
    { id: "newer", created_at: "2026-10-25T10:00:01.000Z" },
    { id: "bad", created_at: "not-a-date" },
    null,
  ];
  assert.deepEqual(messagesAfterCursor(messages, Date.parse("2026-10-25T10:00:00.000Z")).map(m => m.id), ["newer"]);
});

test("missing exact cursor falls back to the timestamp", () => {
  const messages = [
    { id: "equal", created_at: "2026-10-25T10:00:00.000Z" },
    { id: "newer", created_at: "2026-10-25T10:00:01.000Z" },
  ];
  assert.deepEqual(messagesAfterCursor(messages, Date.parse("2026-10-25T10:00:00.000Z"), "not-in-window").map(m => m.id), ["newer"]);
});

test("group task MCP tools require scoped identities, bounded content, and explicit idempotency", () => {
  const taskId = "550e8400-e29b-41d4-a716-446655440000";
  const submissionKey = "550e8400-e29b-41d4-a716-446655440001";
  const messageId = "550e8400-e29b-41d4-a716-446655440002";
  assert.equal(validateToolArguments("list_group_tasks", {}), null);
  assert.match(validateToolArguments("list_group_tasks", { room_id: taskId }), /arguments/);
  assert.equal(validateToolArguments("read_group_task", { task_id: taskId }), null);
  assert.match(validateToolArguments("read_group_task", { task_id: "bad" }), /UUID/);
  assert.equal(validateToolArguments("claim_group_task", { task_id: taskId }), null);
  assert.equal(validateToolArguments("block_group_task", { task_id: taskId, reason: "Waiting for the API key owner." }), null);
  assert.match(validateToolArguments("block_group_task", { task_id: taskId, reason: " " }), /reason/);
  assert.equal(validateToolArguments("fail_group_task", { task_id: taskId, reason: "The provider no longer exposes this capability." }), null);
  assert.match(validateToolArguments("fail_group_task", { task_id: taskId, reason: " " }), /reason/);
  assert.equal(validateToolArguments("submit_group_task_result", {
    task_id: taskId, result: "Implementation and test evidence.", submission_key: submissionKey, source_message_ids: [messageId],
  }), null);
  assert.match(validateToolArguments("submit_group_task_result", {
    task_id: taskId, result: "ok", submission_key: "bad",
  }), /submission_key/);
  assert.match(validateToolArguments("submit_group_task_result", {
    task_id: taskId, result: "ok", submission_key: submissionKey, source_message_ids: [messageId, messageId],
  }), /unique UUIDs/);
  assert.match(validateToolArguments("submit_group_task_result", {
    task_id: taskId, result: " ", submission_key: submissionKey,
  }), /result/);
  assert.match(validateToolArguments("submit_group_task_result", {
    task_id: taskId, result: "ok", submission_key: submissionKey, arbitrary_room_id: taskId,
  }), /Unknown/);
  assert.equal(validateToolArguments("propose_group_task", {
    title: "Audit deployment pipeline",
    description: "Inspect the existing pipeline without changing production.",
    expected_output: "A tested report and recommended changes.",
    acceptance_criteria: ["Production remains unchanged", "Evidence is linked"],
    priority: 2,
    idempotency_key: taskId,
  }), null);
  assert.match(validateToolArguments("propose_group_task", {
    title: " ",
    idempotency_key: taskId,
  }), /title/);
  assert.match(validateToolArguments("propose_group_task", {
    title: "Task",
    acceptance_criteria: ["ok".repeat(300)],
    idempotency_key: taskId,
  }), /acceptance_criteria/);
  assert.match(validateToolArguments("propose_group_task", {
    title: "Task",
    idempotency_key: taskId,
    force: true,
  }), /Unknown/);
});


test("original-session bridge state tools are listed, session-scoped, and fail closed on malformed CAS state", () => {
  const names = new Set(getModernMcpTools().map(tool => tool.name));
  assert.ok(names.has("load_original_session_bridge_state"));
  assert.ok(names.has("save_original_session_bridge_state"));
  const load = RUB_MINDS_MCP_TOOLS.find(tool => tool.name === "load_original_session_bridge_state");
  const save = RUB_MINDS_MCP_TOOLS.find(tool => tool.name === "save_original_session_bridge_state");
  assert.ok(load);
  assert.ok(save);
  assert.deepEqual(save.inputSchema.required, [
    "expected_revision", "cursor_created_at", "cursor_message_id", "pending_message_id",
    "pending_message_created_at", "pending_response", "blocked_message_id", "blocked_reason",
  ]);
  for (const tool of [load, save]) {
    const modern = getModernMcpTools().find(item => item.name === tool.name);
    assert.ok(modern.inputSchema.required.includes("session_handle"), tool.name);
    assert.equal(modern.inputSchema.properties.session_handle.pattern, "^[a-fA-F0-9]{64}$");
  }
  const id = "550e8400-e29b-41d4-a716-446655440000";
  const otherId = "550e8400-e29b-41d4-a716-446655440001";
  const validEmpty = {
    expected_revision: 0,
    cursor_created_at: null,
    cursor_message_id: null,
    pending_message_id: null,
    pending_message_created_at: null,
    pending_response: null,
    blocked_message_id: null,
    blocked_reason: null,
  };
  assert.equal(validateToolArguments("load_original_session_bridge_state", {}), null);
  assert.match(validateToolArguments("load_original_session_bridge_state", { room_id: id }), /arguments/);
  assert.equal(validateToolArguments("save_original_session_bridge_state", validEmpty), null);
  assert.match(validateToolArguments("save_original_session_bridge_state", { ...validEmpty, expected_revision: -1 }), /revision/);
  assert.match(validateToolArguments("save_original_session_bridge_state", { ...validEmpty, cursor_created_at: "2026-11-01T00:00:00Z" }), /cursor_created_at/);
  assert.match(validateToolArguments("save_original_session_bridge_state", { ...validEmpty, cursor_message_id: id }), /cursor_created_at/);
  assert.match(validateToolArguments("save_original_session_bridge_state", {
    ...validEmpty, cursor_created_at: "2026-11-01T00:00:00", cursor_message_id: id,
  }), /cursor_created_at/);
  assert.match(validateToolArguments("save_original_session_bridge_state", {
    ...validEmpty, cursor_created_at: "2026-11-01T00:00:00.1234567Z", cursor_message_id: id,
  }), /cursor_created_at/);
  assert.equal(validateToolArguments("save_original_session_bridge_state", {
    ...validEmpty, cursor_created_at: "2026-11-01T00:00:00.123456Z", cursor_message_id: id,
  }), null);
  assert.match(validateToolArguments("save_original_session_bridge_state", {
    ...validEmpty, pending_message_id: id, pending_response: "answer",
  }), /pending message/);
  assert.equal(validateToolArguments("save_original_session_bridge_state", {
    ...validEmpty, pending_message_id: id, pending_message_created_at: "2026-11-01T00:00:00Z",
    pending_response: "A completed provider response.",
  }), null);
  assert.match(validateToolArguments("save_original_session_bridge_state", {
    ...validEmpty, pending_message_id: id, pending_message_created_at: "2026-11-01T00:00:00Z",
    pending_response: "x".repeat(10001),
  }), /pending message/);
  assert.equal(validateToolArguments("save_original_session_bridge_state", {
    ...validEmpty, blocked_message_id: otherId, blocked_reason: "provider_prompt_in_progress",
  }), null);
  assert.match(validateToolArguments("save_original_session_bridge_state", {
    ...validEmpty, blocked_message_id: otherId,
  }), /blocked_message_id/);
  assert.match(validateToolArguments("save_original_session_bridge_state", {
    ...validEmpty,
    pending_message_id: id,
    pending_message_created_at: "2026-11-01T00:00:00Z",
    pending_response: "A completed response.",
    blocked_message_id: otherId,
    blocked_reason: "provider_prompt_in_progress",
  }), /cannot coexist/);
  assert.match(validateToolArguments("save_original_session_bridge_state", { ...validEmpty, extra: true }), /Unknown/);
});

test("message cursor comparator preserves timezone offsets and exact microsecond ordering", () => {
  const cursor = { id: "message-40", created_at: "2026-10-24T17:00:00.123456+00:00" };
  assert.equal(compareMessageCursors(
    { id: "message-41", created_at: "2026-10-24T19:00:00.123456+02:00" }, cursor
  ), 1);
  assert.equal(compareMessageCursors(
    { id: "message-39", created_at: "2026-10-24T19:00:00.123456+02:00" }, cursor
  ), -1);
  assert.equal(compareMessageCursors(
    { id: "message-99", created_at: "2026-10-24T19:00:00.123455+02:00" }, cursor
  ), -1);
  assert.equal(isValidMessageCursor(cursor), true);
  assert.equal(isValidMessageCursor({ created_at: "2026-10-24T17:00:00.000Z" }), false);
  assert.equal(isValidMessageCursor({ id: "bad", created_at: "invalid" }), false);
});

test("read_group_messages validates composite pagination and bounded page sizes", () => {
  const cursorId = "550e8400-e29b-41d4-a716-446655440000";
  const timestamp = "2026-11-01T18:00:00.123456Z";
  assert.equal(validateToolArguments("read_group_messages", {}), null);
  assert.equal(validateToolArguments("read_group_messages", { limit: 100 }), null);
  assert.equal(validateToolArguments("read_group_messages", {
    after_created_at: timestamp,
    after_message_id: cursorId,
    limit: 1,
  }), null);
  assert.match(validateToolArguments("read_group_messages", {
    after_created_at: timestamp,
  }), /both be supplied/);
  assert.match(validateToolArguments("read_group_messages", {
    after_message_id: cursorId,
  }), /both be supplied/);
  assert.match(validateToolArguments("read_group_messages", {
    after_created_at: "2026-11-01 18:00:00",
    after_message_id: cursorId,
  }), /ISO date-time/);
  assert.match(validateToolArguments("read_group_messages", {
    after_created_at: timestamp,
    after_message_id: cursorId,
    limit: 101,
  }), /limit/);
  assert.match(validateToolArguments("read_group_messages", {
    limit: 50,
    offset: 10,
  }), /Unknown/);
  assert.equal(validateToolArguments("wait_for_group_messages", {
    timeout_ms: 1000, limit: 1,
    after_created_at: timestamp, after_message_id: cursorId,
  }), null);
  assert.match(validateToolArguments("wait_for_group_messages", {
    after_created_at: timestamp,
  }), /supplied together/);
  assert.match(validateToolArguments("wait_for_group_messages", {
    after_message_id: cursorId,
  }), /supplied together/);
  assert.match(validateToolArguments("wait_for_group_messages", {
    timeout_ms: 1000, limit: 101,
  }), /limit/);
});

test("MCP discovery defines the safe Backroom wake response and recovery protocol",()=>{
  assert.match(MCP_DISCOVERY_INSTRUCTIONS,/read_group_message/);
  assert.match(MCP_DISCOVERY_INSTRUCTIONS,/Event UUID/);
  assert.match(MCP_DISCOVERY_INSTRUCTIONS,/load_original_session_bridge_state/);
  assert.match(MCP_DISCOVERY_INSTRUCTIONS,/pending_response/);
  assert.match(MCP_DISCOVERY_INSTRUCTIONS,/source_message_id/);
  assert.match(MCP_DISCOVERY_INSTRUCTIONS,/revision conflict/);
  assert.match(MCP_DISCOVERY_INSTRUCTIONS,/does not confirm group delivery/);
  assert.match(MCP_DISCOVERY_INSTRUCTIONS,/provider-side tool permission prompts cannot be bypassed/);
});

test("exact group-message lookup is UUID-scoped and rejects unknown inputs",()=>{
  const id="550e8400-e29b-41d4-a716-446655440000";
  assert.equal(validateToolArguments("read_group_message",{message_id:id}),null);
  assert.match(validateToolArguments("read_group_message",{}),/message_id/);
  assert.match(validateToolArguments("read_group_message",{message_id:"not-a-uuid"}),/UUID/);
  assert.match(validateToolArguments("read_group_message",{message_id:id,room_id:"other"}),/Unknown/);
});
test("MCP tool list exposes exact group-message lookup only with a UUID",()=>{
  const tool=getModernMcpTools().find(item=>item.name==="read_group_message");
  assert.ok(tool);
  assert.ok(tool.inputSchema.required.includes("message_id"));
  assert.equal(tool.inputSchema.properties.message_id.format,"uuid");
});
