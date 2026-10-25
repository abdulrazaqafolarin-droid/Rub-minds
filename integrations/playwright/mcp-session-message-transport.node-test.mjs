import test from "node:test";
import assert from "node:assert/strict";
import { McpSessionMessageTransport } from "./mcp-session-message-transport.mjs";

const SESSION = "a".repeat(64);
const ENDPOINT = "https://rub-minds.example/functions/v1/rub-minds-mcp";

function fakeResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function fakeFetch(handler) {
  const requests = [];
  return {
    requests,
    fetch: async (url, options) => {
      const request = JSON.parse(options.body);
      requests.push({ url, options, request });
      return handler({ url, options, request, index: requests.length - 1 });
    },
  };
}

test("validates secure endpoint, session handle, timeout bounds, and adapter inputs", () => {
  assert.throws(() => new McpSessionMessageTransport({ endpoint: "http://example.com/mcp", sessionHandle: SESSION }), /HTTPS/);
  assert.throws(() => new McpSessionMessageTransport({ endpoint: "https://user:pass@example.com/mcp", sessionHandle: SESSION }), /credentials/);
  assert.throws(() => new McpSessionMessageTransport({ endpoint: "https://example.com/mcp?token=secret", sessionHandle: SESSION }), /query parameters/);
  assert.throws(() => new McpSessionMessageTransport({ endpoint: ENDPOINT, sessionHandle: "short" }), /64-character/);
  assert.throws(() => new McpSessionMessageTransport({ endpoint: ENDPOINT, sessionHandle: SESSION, waitTimeoutMs: 999 }), /waitTimeoutMs/);
  assert.throws(() => new McpSessionMessageTransport({ endpoint: ENDPOINT, sessionHandle: SESSION, waitTimeoutMs: 15000, requestTimeoutMs: 15000 }), /requestTimeoutMs/);
  assert.throws(() => new McpSessionMessageTransport({ endpoint: ENDPOINT, sessionHandle: SESSION, fetchImpl: null }), /fetchImpl/);
});

test("uses session-scoped JSON-RPC headers and keeps the session handle out of the URL", async () => {
  const fake = fakeFetch(({ request }) => fakeResponse({
    jsonrpc: "2.0",
    id: request.id,
    result: { structuredContent: { messages: [] } },
  }));
  const transport = new McpSessionMessageTransport({ endpoint: ENDPOINT, sessionHandle: SESSION, fetchImpl: fake.fetch });
  const result = await transport.readMessages({ baseline: true });
  assert.deepEqual(result.messages, []);
  assert.equal(fake.requests.length, 1);
  const request = fake.requests[0];
  assert.equal(request.url, ENDPOINT);
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["MCP-Protocol-Version"], "2026-07-28");
  assert.equal(request.options.headers["Mcp-Name"], "read_group_messages");
  assert.ok(!request.url.includes(SESSION));
  assert.equal(request.request.params.arguments.session_handle, SESSION);
  assert.equal(request.request.params.name, "read_group_messages");
});

test("cursor reads forward the exact composite cursor, bounded limit, and read wait", async () => {
  const cursor = {
    after_created_at: "2026-10-24T17:00:00.123456+00:00",
    after_message_id: "00000000-0000-4000-8000-000000000042",
  };
  const fake = fakeFetch(({ request }) => fakeResponse({
    jsonrpc: "2.0",
    id: request.id,
    result: { structuredContent: { messages: [], timed_out: true, next_cursor: cursor } },
  }));
  const transport = new McpSessionMessageTransport({
    endpoint: ENDPOINT, sessionHandle: SESSION, fetchImpl: fake.fetch, waitTimeoutMs: 2000,
  });
  const adapters = transport.createBridgeAdapters();
  const result = await adapters.readMessages({ cursor, limit: 9 });
  assert.equal(result.timed_out, true);
  const sent = fake.requests[0].request.params;
  assert.equal(sent.name, "wait_for_group_messages");
  assert.equal(sent.arguments.after_created_at, cursor.after_created_at);
  assert.equal(sent.arguments.after_message_id, cursor.after_message_id);
  assert.equal(sent.arguments.timeout_ms, 2000);
  assert.equal(sent.arguments.limit, 9);
  assert.equal(sent.arguments.session_handle, SESSION);
});

test("message sends include a stable source_message_id for server-side deduplication", async () => {
  const fake = fakeFetch(({ request }) => fakeResponse({
    jsonrpc: "2.0",
    id: request.id,
    result: { structuredContent: { message_id: "00000000-0000-4000-8000-000000000099" } },
  }));
  const transport = new McpSessionMessageTransport({ endpoint: ENDPOINT, sessionHandle: SESSION, fetchImpl: fake.fetch });
  const result = await transport.sendMessage("reply", "source-123");
  assert.ok(result.message_id);
  const params = fake.requests[0].request.params;
  assert.equal(params.name, "send_group_message");
  assert.equal(params.arguments.body, "reply");
  assert.equal(params.arguments.source_message_id, "source-123");
});

test("fails closed on HTTP, JSON-RPC, and tool errors without echoing session capability", async () => {
  let fake = fakeFetch(() => fakeResponse({ error: "server problem" }, 503));
  let transport = new McpSessionMessageTransport({ endpoint: ENDPOINT, sessionHandle: SESSION, fetchImpl: fake.fetch });
  await assert.rejects(() => transport.readMessages(), error => {
    assert.match(error.message, /HTTP 503/);
    assert.equal(error.message.includes(SESSION), false);
    return true;
  });

  fake = fakeFetch(({ request }) => fakeResponse({ jsonrpc: "2.0", id: request.id, error: { message: "internal failure" } }));
  transport = new McpSessionMessageTransport({ endpoint: ENDPOINT, sessionHandle: SESSION, fetchImpl: fake.fetch });
  await assert.rejects(() => transport.readMessages(), /call failed/);

  fake = fakeFetch(({ request }) => fakeResponse({ jsonrpc: "2.0", id: request.id, result: { isError: true, structuredContent: { error: SESSION } } }));
  transport = new McpSessionMessageTransport({ endpoint: ENDPOINT, sessionHandle: SESSION, fetchImpl: fake.fetch });
  await assert.rejects(() => transport.sendMessage("reply", "source-123"), /tool returned an error/);
});

test("rejects mismatched RPC ids and invalid structured message responses", async () => {
  const fake = fakeFetch(() => fakeResponse({ jsonrpc: "2.0", id: 999, result: { structuredContent: { messages: [] } } }));
  const transport = new McpSessionMessageTransport({ endpoint: ENDPOINT, sessionHandle: SESSION, fetchImpl: fake.fetch });
  await assert.rejects(() => transport.readMessages(), /invalid JSON-RPC response/);

  const bad = fakeFetch(({ request }) => fakeResponse({ jsonrpc: "2.0", id: request.id, result: { structuredContent: { messages: "invalid" } } }));
  const badTransport = new McpSessionMessageTransport({ endpoint: ENDPOINT, sessionHandle: SESSION, fetchImpl: bad.fetch });
  await assert.rejects(() => badTransport.readMessages(), /no message list/);
});

test("propagates request cancellation and does not call fetch for an already-aborted signal", async () => {
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls++;
    assert.ok(options.signal instanceof AbortSignal);
    return fakeResponse({
      jsonrpc: "2.0",
      id: JSON.parse(options.body).id,
      result: { structuredContent: { messages: [] } },
    });
  };
  const transport = new McpSessionMessageTransport({ endpoint: ENDPOINT, sessionHandle: SESSION, fetchImpl });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => transport.readMessages({ signal: controller.signal }), /aborted/);
  assert.equal(calls, 0);
});
