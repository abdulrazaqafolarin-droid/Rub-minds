import test from "node:test";
import assert from "node:assert/strict";
import { McpSessionMessageTransport, joinRubMindsInvite } from "./mcp-session-message-transport.mjs";

const SESSION = "a".repeat(64);
const ENDPOINT = "https://rub-minds.example/functions/v1/rub-minds-mcp";
const BASE_TIME = "2026-10-24T17:00:00.000000+00:00";
const NEW_TIME = "2026-10-24T17:00:00.000001+00:00";

function fakeResponse(payload, status = 200, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => payload };
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

test("redeems a Staging invitation through modern MCP with a returned opaque session handle", async () => {
  const inviteToken = "b".repeat(64);
  const joinRequestKey = "c".repeat(64);
  const sessionHandle = "d".repeat(64);
  const roomId = "550e8400-e29b-41d4-a716-446655440000";
  const participantId = "650e8400-e29b-41d4-a716-446655440000";
  const fake = fakeFetch(({ request }) => fakeResponse({
    jsonrpc: "2.0",
    id: request.id,
    result: { structuredContent: {
      joined: true,
      session_handle: sessionHandle,
      room_id: roomId,
      participant_id: participantId,
      expires_at: "2026-11-20T00:00:00.000Z",
    } },
  }));
  const joined = await joinRubMindsInvite({
    endpoint: "https://tzcuuynmviiuactafpld.supabase.co/functions/v1/rub-minds-mcp",
    inviteToken,
    joinRequestKey,
    agentLabel: "ChatGPT original session",
    fetchImpl: fake.fetch,
  });
  assert.deepEqual(joined, {
    joined: true, sessionHandle, roomId, participantId, expiresAt: "2026-11-20T00:00:00.000Z",
  });
  assert.equal(fake.requests.length, 1);
  const request = fake.requests[0];
  assert.equal(request.request.method, "tools/call");
  assert.equal(request.request.params.name, "join_group");
  assert.equal(request.request.params._meta["io.modelcontextprotocol/protocolVersion"], "2026-07-28");
  assert.deepEqual(request.request.params.arguments, {
    invite_token: inviteToken,
    agent_label: "ChatGPT original session",
    confirm_join: true,
    join_request_key: joinRequestKey,
  });
  assert.equal(request.options.headers["MCP-Protocol-Version"], "2026-07-28");
  assert.equal(request.options.headers["Mcp-Method"], "tools/call");
  assert.equal(request.options.headers["Mcp-Name"], "join_group");
  assert.equal(request.options.headers["Mcp-Session-Id"], undefined);
  assert.equal(request.url.includes(inviteToken), false);
  assert.equal(request.url.includes(joinRequestKey), false);
});

test("retries an ambiguous modern join with the identical durable idempotency key", async () => {
  const inviteToken = "e".repeat(64);
  const joinRequestKey = "f".repeat(64);
  const sessionHandle = "a".repeat(64);
  const requests = [];
  let calls = 0;
  const fetchImpl = async (url, options) => {
    const request = JSON.parse(options.body);
    requests.push({ url, options, request });
    calls++;
    if (calls === 1) throw new TypeError("connection closed after the server accepted the request");
    return fakeResponse({
      jsonrpc: "2.0",
      id: request.id,
      result: { structuredContent: {
        joined: true,
        session_handle: sessionHandle,
        room_id: "550e8400-e29b-41d4-a716-446655440000",
        participant_id: "650e8400-e29b-41d4-a716-446655440000",
        expires_at: "2026-11-20T00:00:00.000Z",
      } },
    });
  };
  const joined = await joinRubMindsInvite({
    endpoint: "https://tzcuuynmviiuactafpld.supabase.co/functions/v1/rub-minds-mcp",
    inviteToken,
    joinRequestKey,
    agentLabel: "Claude original session",
    fetchImpl,
  });
  assert.equal(joined.joined, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].request, requests[1].request);
  assert.equal(requests[0].request.params.arguments.join_request_key, joinRequestKey);
  assert.equal(requests[1].request.params.arguments.join_request_key, joinRequestKey);
});

test("rejects Production, missing join keys and invalid invitation inputs before network access", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error("must not call fetch"); };
  const valid = {
    endpoint: "https://tzcuuynmviiuactafpld.supabase.co/functions/v1/rub-minds-mcp",
    inviteToken: "a".repeat(64),
    joinRequestKey: "b".repeat(64),
    agentLabel: "ChatGPT",
    fetchImpl,
  };
  for (const input of [
    { ...valid, endpoint: "https://zucaeevlbwhcvjwbhwmq.supabase.co/functions/v1/rub-minds-mcp" },
    { ...valid, endpoint: "http://127.0.0.1:54321/functions/v1/rub-minds-mcp" },
    { ...valid, inviteToken: "short" },
    { ...valid, joinRequestKey: "short" },
    { ...valid, agentLabel: " " },
    { ...valid, agentLabel: "x".repeat(81) },
  ]) {
    await assert.rejects(() => joinRubMindsInvite(input));
  }
  assert.equal(calls, 0);
});

test("explicit local loopback testing is opt-in and cannot redirect invite redemption to Production", async () => {
  const sessionHandle = "d".repeat(64);
  const fake = fakeFetch(({ request }) => fakeResponse({
    jsonrpc: "2.0", id: request.id,
    result: { structuredContent: {
      joined: true,
      session_handle: sessionHandle,
      room_id: "550e8400-e29b-41d4-a716-446655440000",
      participant_id: "650e8400-e29b-41d4-a716-446655440000",
      expires_at: "2026-11-20T00:00:00.000Z",
    } },
  }));
  const input = {
    endpoint: "http://127.0.0.1:54321/functions/v1/rub-minds-mcp",
    inviteToken: "a".repeat(64),
    joinRequestKey: "b".repeat(64),
    agentLabel: "CI local test",
    fetchImpl: fake.fetch,
  };
  await assert.rejects(() => joinRubMindsInvite(input), /Staging MCP endpoint/);
  const joined = await joinRubMindsInvite({ ...input, allowLocalTestEndpoint: true });
  assert.equal(joined.joined, true);
  await assert.rejects(() => joinRubMindsInvite({
    ...input,
    endpoint: "https://zucaeevlbwhcvjwbhwmq.supabase.co/functions/v1/rub-minds-mcp",
    allowLocalTestEndpoint: true,
  }), /Staging MCP endpoint/);
});

test("rejects malformed modern join identity without exposing opaque bearer handles", async () => {
  const secret = "9".repeat(64);
  const fake = fakeFetch(({ request }) => fakeResponse({
    jsonrpc: "2.0", id: request.id,
    result: { structuredContent: {
      joined: true,
      session_handle: secret,
      room_id: "not-a-uuid",
      participant_id: "650e8400-e29b-41d4-a716-446655440000",
      expires_at: "2026-11-20T00:00:00.000Z",
    } },
  }));
  await assert.rejects(
    () => joinRubMindsInvite({
      endpoint: "https://tzcuuynmviiuactafpld.supabase.co/functions/v1/rub-minds-mcp",
      inviteToken: "a".repeat(64), joinRequestKey: "b".repeat(64),
      agentLabel: "ChatGPT", fetchImpl: fake.fetch,
    }),
    error => {
      assert.match(error.message, /incomplete invitation join/);
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});

test("does not retry after a definite server invitation or protocol rejection", async () => {
  let calls = 0;
  const fake = fakeFetch(({ request }) => {
    calls++;
    return fakeResponse({
      jsonrpc: "2.0",
      id: request.id,
      result: { isError: true, structuredContent: { error: "Invitation is invalid or expired." } },
    });
  });
  await assert.rejects(() => joinRubMindsInvite({
    endpoint: "https://tzcuuynmviiuactafpld.supabase.co/functions/v1/rub-minds-mcp",
    inviteToken: "a".repeat(64), joinRequestKey: "b".repeat(64),
    agentLabel: "ChatGPT", fetchImpl: fake.fetch,
  }), /redemption failed/);
  assert.equal(calls, 1);
});

test("uses session-scoped JSON-RPC headers and keeps the session handle out of the URL", async () => {
  const fake = fakeFetch(({ request }) => fakeResponse({
    jsonrpc: "2.0",
    id: request.id,
    result: { structuredContent: { messages: [] } },
  }));
  const transport = new McpSessionMessageTransport({ endpoint: ENDPOINT, sessionHandle: SESSION, fetchImpl: fake.fetch });
  const result = await transport.readMessages({ baseline: true, limit: 77 });
  assert.deepEqual(result.messages, []);
  assert.equal(fake.requests.length, 1);
  const request = fake.requests[0];
  assert.equal(request.url, ENDPOINT);
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["MCP-Protocol-Version"], "2026-07-28");
  assert.equal(request.options.headers["Mcp-Name"], "read_group_messages");
  assert.ok(!request.url.includes(SESSION));
  assert.equal(request.request.params.arguments.session_handle, SESSION);
  assert.equal(request.request.params.arguments.limit, 77, "no-cursor snapshots must forward the requested page limit");
  assert.equal(request.request.params.name, "read_group_messages");
});

test("empty startup snapshots return a valid epoch cursor and only permit message tools", async () => {
  const fake = fakeFetch(({ request }) => fakeResponse({
    jsonrpc: "2.0",
    id: request.id,
    result: { structuredContent: { messages: [] } },
  }));
  const transport = new McpSessionMessageTransport({
    endpoint: ENDPOINT, sessionHandle: SESSION, fetchImpl: fake.fetch,
  });
  const snapshot = await transport.readMessages({ baseline: true });
  assert.equal(fake.requests[0].request.params.arguments.limit, 100, "the default startup snapshot limit must be forwarded");
  assert.deepEqual(snapshot.next_cursor, {
    after_created_at: "1970-01-01T00:00:00.000Z",
    after_message_id: "00000000-0000-1000-8000-000000000000",
  });
  await assert.rejects(() => transport.callTool("join_group", { invite_token: "x" }), /only supports/);
  await assert.rejects(() => transport.callTool("read_session_memory", {}), /only supports/);
});

test("reads verified room and self participant identity and can revoke the exact joined session", async () => {
  const roomId = "550e8400-e29b-41d4-a716-446655440000";
  const participantId = "650e8400-e29b-41d4-a716-446655440000";
  const fake = fakeFetch(({ request }) => {
    const name = request.params.name;
    if (name === "read_group_context") {
      return fakeResponse({ jsonrpc: "2.0", id: request.id, result: { structuredContent: {
        room: { id: roomId, title: "Staging room" },
        self: { participant_id: participantId },
        participants: [],
      } } });
    }
    if (name === "leave_group") {
      assert.equal(request.params.arguments.confirm_leave, true);
      return fakeResponse({ jsonrpc: "2.0", id: request.id, result: { structuredContent: { left: true } } });
    }
    throw new Error("Unexpected session identity tool " + name);
  });
  const transport = new McpSessionMessageTransport({ endpoint: ENDPOINT, sessionHandle: SESSION, fetchImpl: fake.fetch });
  const context = await transport.readGroupContext();
  assert.equal(context.room.id, roomId);
  assert.equal(context.self.participant_id, participantId);
  assert.deepEqual(await transport.leaveGroup(), { left: true });
  assert.deepEqual(fake.requests.map(item => item.request.params.name), ["read_group_context", "leave_group"]);
});

test("task transport can block a claimed assignment for human recovery", async () => {
  const taskId = "550e8400-e29b-41d4-a716-446655440000";
  const reason = "Original-session provider Send outcome is ambiguous; inspect the conversation.";
  const fake = fakeFetch(({ request }) => {
    assert.equal(request.params.name, "block_group_task");
    assert.deepEqual(request.params.arguments, {
      task_id: taskId,
      reason,
      session_handle: SESSION,
    });
    return fakeResponse({ jsonrpc: "2.0", id: request.id, result: { structuredContent: {
      blocked: true, task_id: taskId, status: "blocked",
    } } });
  });
  const tasks = new McpSessionMessageTransport({ endpoint: ENDPOINT, sessionHandle: SESSION, fetchImpl: fake.fetch }).createTaskAdapters();
  const result = await tasks.blockTask(taskId, reason);
  assert.equal(result.blocked, true);
  assert.equal(fake.requests.length, 1);
});

test("task transport lists, reads, claims and submits under the same exact MCP participant session", async () => {
  const taskId = "550e8400-e29b-41d4-a716-446655440000";
  const submissionKey = "650e8400-e29b-41d4-a716-446655440000";
  const resultText = "A reviewed-ready deliverable.";
  const fake = fakeFetch(({ request }) => {
    const name = request.params.name;
    const args = request.params.arguments;
    let structuredContent;
    if (name === "list_group_tasks") {
      assert.equal(Object.keys(args).length, 1);
      structuredContent = { tasks: [{ id: taskId, status: "assigned" }] };
    } else if (name === "read_group_task") {
      structuredContent = {
        task: { id: taskId, status: "assigned" },
        prerequisites: [],
        submissions: [],
        reviews: [],
      };
    } else if (name === "claim_group_task") {
      structuredContent = { claimed: true, status: "in_progress" };
    } else if (name === "submit_group_task_result") {
      structuredContent = { submitted: true, replayed: false, status: "review" };
    } else {
      throw new Error("Unexpected task tool " + name);
    }
    return fakeResponse({ jsonrpc: "2.0", id: request.id, result: { structuredContent } });
  });
  const transport = new McpSessionMessageTransport({ endpoint: ENDPOINT, sessionHandle: SESSION, fetchImpl: fake.fetch });
  const tasks = transport.createTaskAdapters();
  assert.equal((await tasks.listTasks()).tasks.length, 1);
  assert.equal((await tasks.readTask(taskId)).task.id, taskId);
  assert.equal((await tasks.claimTask(taskId)).claimed, true);
  assert.equal((await tasks.submitTaskResult({
    taskId, result: resultText, submissionKey, sourceMessageIds: [],
  })).submitted, true);
  assert.deepEqual(fake.requests.map(item => item.request.params.name), [
    "list_group_tasks", "read_group_task", "claim_group_task", "submit_group_task_result",
  ]);
  assert.ok(fake.requests.every(item => item.request.params.arguments.session_handle === SESSION));
  assert.equal(fake.requests[3].request.params.arguments.submission_key, submissionKey);
  assert.equal(fake.requests[3].request.params.arguments.result, resultText);
});

test("task transport rejects malformed identifiers and result payloads before network access", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error("must not call network"); };
  const transport = new McpSessionMessageTransport({ endpoint: ENDPOINT, sessionHandle: SESSION, fetchImpl });
  const tasks = transport.createTaskAdapters();
  await assert.rejects(() => tasks.readTask("not-a-uuid"), /UUID/);
  await assert.rejects(() => tasks.claimTask("not-a-uuid"), /UUID/);
  await assert.rejects(() => tasks.submitTaskResult({
    taskId: "550e8400-e29b-41d4-a716-446655440000",
    result: "",
    submissionKey: "650e8400-e29b-41d4-a716-446655440000",
  }), /1-20000/);
  await assert.rejects(() => tasks.submitTaskResult({
    taskId: "550e8400-e29b-41d4-a716-446655440000",
    result: "answer",
    submissionKey: "bad",
  }), /submissionKey/);
  assert.equal(calls, 0);
});

test("cursor reads use immediate composite paging with a bounded page limit", async () => {
  const cursor = {
    after_created_at: "2026-10-24T17:00:00.123456+00:00",
    after_message_id: "00000000-0000-4000-8000-000000000042",
  };
  const fake = fakeFetch(({ request }) => fakeResponse({
    jsonrpc: "2.0",
    id: request.id,
    result: { structuredContent: { messages: [], next_cursor: cursor } },
  }));
  const transport = new McpSessionMessageTransport({
    endpoint: ENDPOINT, sessionHandle: SESSION, fetchImpl: fake.fetch, waitTimeoutMs: 2000,
  });
  const adapters = transport.createBridgeAdapters();
  const result = await adapters.readMessages({ cursor, limit: 9 });
  assert.deepEqual(result.next_cursor, cursor);
  const sent = fake.requests[0].request.params;
  assert.equal(sent.name, "read_group_messages");
  assert.equal(sent.arguments.after_created_at, cursor.after_created_at);
  assert.equal(sent.arguments.after_message_id, cursor.after_message_id);
  assert.equal(sent.arguments.timeout_ms, undefined);
  assert.equal(sent.arguments.limit, 9);
  assert.equal(sent.arguments.session_handle, SESSION);
});

test("uses the hosted MCP wait tool as a scoped wake source and forwards the bridge cursor", async () => {
  const cursor = {
    after_created_at: "2026-10-24T17:00:00.123456+00:00",
    after_message_id: "00000000-0000-4000-8000-000000000042",
  };
  const fake = fakeFetch(({ request }) => fakeResponse({
    jsonrpc: "2.0",
    id: request.id,
    result: { structuredContent: {
      timed_out: false,
      delivery: "realtime",
      messages: [{ id: "00000000-0000-4000-8000-000000000043" }],
      next_cursor: {
        after_created_at: "2026-10-24T17:00:00.123457+00:00",
        after_message_id: "00000000-0000-4000-8000-000000000043",
      },
    } },
  }));
  const transport = new McpSessionMessageTransport({
    endpoint: ENDPOINT,
    sessionHandle: SESSION,
    fetchImpl: fake.fetch,
    waitTimeoutMs: 5000,
    requestTimeoutMs: 20000,
  });
  const source = transport.createWakeSource();
  assert.deepEqual(await source.start(), { status: "ready" });
  const result = await source.waitForWake({ timeoutMs: 4000, cursor });
  assert.deepEqual(result, { status: "wake", delivery: "realtime", messageCount: 1 });
  const request = fake.requests[0].request.params;
  assert.equal(request.name, "wait_for_group_messages");
  assert.equal(request.arguments.after_created_at, cursor.after_created_at);
  assert.equal(request.arguments.after_message_id, cursor.after_message_id);
  assert.equal(request.arguments.timeout_ms, 4000);
  assert.equal(request.arguments.limit, 1);
  assert.equal(request.arguments.session_handle, SESSION);
  await source.close();
});

test("maps timeout and unavailable MCP wait results to a recoverable wake timeout", async () => {
  const fake = fakeFetch(({ request }) => fakeResponse({
    jsonrpc: "2.0",
    id: request.id,
    result: { structuredContent: { timed_out: true, delivery: "unavailable", messages: [], next_cursor: null } },
  }));
  const transport = new McpSessionMessageTransport({
    endpoint: ENDPOINT,
    sessionHandle: SESSION,
    fetchImpl: fake.fetch,
    waitTimeoutMs: 10000,
    requestTimeoutMs: 20000,
  });
  const result = await transport.waitForWake({
    timeoutMs: 15000,
    cursor: {
      after_created_at: "2026-10-24T17:00:00.000000Z",
      after_message_id: "10000000-0000-4000-8000-000000000001",
    },
  });
  assert.deepEqual(result, { status: "timeout", delivery: "unavailable", messageCount: 0 });
  const args = fake.requests[0].request.params.arguments;
  assert.equal(args.timeout_ms, 10000, "wake wait must respect the configured request timeout budget");
  assert.equal(args.after_message_id, "10000000-0000-4000-8000-000000000001");
});

test("loads and revision-checks durable session bridge state", async () => {
  let revision = 4;
  const fake = fakeFetch(({ request }) => {
    const name = request.params.name;
    const args = request.params.arguments;
    let structuredContent;
    if (name === "load_original_session_bridge_state") {
      structuredContent = {
        revision,
        cursor: { after_created_at: BASE_TIME, after_message_id: "10000000-0000-4000-8000-000000000001" },
        pending_response: null,
        blocked_message: null,
      };
    } else if (name === "save_original_session_bridge_state") {
      assert.equal(args.expected_revision, revision);
      revision++;
      structuredContent = { saved: true, conflict: false, revision };
    } else {
      throw new Error("Unexpected state tool " + name);
    }
    return fakeResponse({ jsonrpc: "2.0", id: request.id, result: { structuredContent } });
  });
  const transport = new McpSessionMessageTransport({ endpoint: ENDPOINT, sessionHandle: SESSION, fetchImpl: fake.fetch });
  const loaded = await transport.loadBridgeState();
  assert.equal(loaded.revision, 4);
  assert.equal(loaded.cursor.after_message_id, "10000000-0000-4000-8000-000000000001");
  const saved = await transport.saveBridgeState({
    expected_revision: loaded.revision,
    cursor: loaded.cursor,
    pending_response: {
      source_message_id: "20000000-0000-4000-8000-000000000002",
      message_created_at: NEW_TIME,
      body: "pending answer",
    },
    blocked_message: null,
  });
  assert.deepEqual(saved, { saved: true, conflict: false, revision: 5 });
  const args = fake.requests[1].request.params.arguments;
  assert.equal(args.session_handle, SESSION);
  assert.equal(args.cursor_message_id, loaded.cursor.after_message_id);
  assert.equal(args.pending_message_id, "20000000-0000-4000-8000-000000000002");
  assert.equal(args.pending_response, "pending answer");
});

test("surfaces a durable bridge-state revision conflict without overwriting it", async () => {
  const fake = fakeFetch(({ request }) => fakeResponse({
    jsonrpc: "2.0", id: request.id,
    result: { structuredContent: { saved: false, conflict: true, revision: 9 } },
  }));
  const transport = new McpSessionMessageTransport({ endpoint: ENDPOINT, sessionHandle: SESSION, fetchImpl: fake.fetch });
  assert.deepEqual(await transport.saveBridgeState({
    expected_revision: 7, cursor: null, pending_response: null, blocked_message: null,
  }), { saved: false, conflict: true, revision: 9 });
  const id = "550e8400-e29b-41d4-a716-446655440000";
  await assert.rejects(() => transport.saveBridgeState({
    expected_revision: 7,
    cursor: null,
    pending_response: { source_message_id: id, message_created_at: NEW_TIME, body: "pending" },
    blocked_message: { message_id: id, reason: "provider_prompt_in_progress" },
  }), /cannot coexist/);
  assert.equal(fake.requests.length, 1, "invalid mixed state must be rejected before an MCP write");
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

test("requires a JSON-RPC 2.0 response envelope", async () => {
  const fake = fakeFetch(({ request }) => fakeResponse({
    jsonrpc: "1.0",
    id: request.id,
    result: { structuredContent: { messages: [] } },
  }));
  const transport = new McpSessionMessageTransport({
    endpoint: ENDPOINT, sessionHandle: SESSION, fetchImpl: fake.fetch,
  });
  await assert.rejects(() => transport.readMessages(), /invalid JSON-RPC response/);
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
