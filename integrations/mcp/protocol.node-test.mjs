import test from "node:test";
import assert from "node:assert/strict";
import {
  MCP_PROTOCOL_VERSION,
  RUB_MINDS_MCP_TOOLS,
  rpcError,
  rpcResult,
  validateSessionMemoryDocument,
  validateToolArguments,
  isAllowedMcpOrigin,
  validateProtocolVersionHeader,
} from "./protocol.mjs";

test("advertises invitation, messaging, and memory tools", () => {
  assert.equal(MCP_PROTOCOL_VERSION, "2025-06-18");
  assert.deepEqual(RUB_MINDS_MCP_TOOLS.map((tool) => tool.name), [
    "join_group", "read_group_context", "read_group_messages", "send_group_message",
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

test("join requires a valid invitation and explicit confirmation", () => {
  const token = "a".repeat(64);
  assert.equal(validateToolArguments("join_group", { invite_token: token, agent_label: "Claude", confirm_join: true }), null);
  assert.match(validateToolArguments("join_group", { invite_token: token, agent_label: "Claude" }), /confirmation/);
  assert.match(validateToolArguments("join_group", { invite_token: "short", agent_label: "Claude", confirm_join: true }), /token/);
  assert.match(validateToolArguments("join_group", { invite_token: token, agent_label: " ", confirm_join: true }), /agent_label/);
  assert.match(validateToolArguments("join_group", { invite_token: token, agent_label: "Claude", confirm_join: true, credential: "leak" }), /Unknown/);
});

test("message tool rejects empty, oversized, and unknown arguments", () => {
  assert.equal(validateToolArguments("read_group_context", {}), null);
  assert.match(validateToolArguments("read_group_context", { room_id: "injected" }), /arguments/);
  assert.equal(validateToolArguments("send_group_message", { body: "hello" }), null);
  assert.match(validateToolArguments("send_group_message", { body: " " }), /body/);
  assert.match(validateToolArguments("send_group_message", { body: "x".repeat(10001) }), /body/);
  assert.match(validateToolArguments("send_group_message", { body: "hello", admin: true }), /Unknown/);
});

test("session memory requires private raw-history visibility and bounded fields", () => {
  const valid = { schema: "rub-minds.session-memory", version: 1, summary: "summary", current_goal: "goal", source: { platform: "ChatGPT" }, sharing: { raw_history_visibility: "private" } };
  assert.equal(validateSessionMemoryDocument(valid), true);
  assert.equal(validateSessionMemoryDocument({ ...valid, sharing: { raw_history_visibility: "group" } }), false);
  assert.equal(validateSessionMemoryDocument({ ...valid, version: 2 }), false);
  assert.equal(validateSessionMemoryDocument({ ...valid, summary: "x".repeat(20001) }), false);
});

test("memory visibility is explicit and idempotency keys are bounded", () => {
  const args = { entry_type: "decision", content: "Use MCP", visibility: "private", idempotency_key: "decision-001" };
  assert.equal(validateToolArguments("remember_memory", args), null);
  assert.match(validateToolArguments("remember_memory", { ...args, visibility: "all" }), /visibility/);
  assert.match(validateToolArguments("remember_memory", { ...args, idempotency_key: "x" }), /idempotency_key/);
});

test("JSON-RPC helpers preserve request ids and error codes", () => {
  assert.deepEqual(rpcResult("abc", { ok: true }), { jsonrpc: "2.0", id: "abc", result: { ok: true } });
  assert.deepEqual(rpcError(2, -32601, "Method not found"), { jsonrpc: "2.0", id: 2, error: { code: -32601, message: "Method not found" } });
});
