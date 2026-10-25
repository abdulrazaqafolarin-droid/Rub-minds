import test from "node:test";
import assert from "node:assert/strict";
import { createOriginalSessionWakeRuntime } from "./original-session-wake-runtime.mjs";

const ROOM = "11111111-1111-4111-8111-111111111111";
const PARTICIPANT = "33333333-3333-4333-8333-333333333333";
const SESSION = "a".repeat(64);
const ENDPOINT = "https://rub-minds.example/functions/v1/rub-minds-mcp";
const BASE_ID = "10000000-0000-4000-8000-000000000001";
const NEW_ID = "20000000-0000-4000-8000-000000000002";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const BASE_TIME = "2026-10-24T17:00:00.000000+00:00";
const NEW_TIME = "2026-10-24T17:00:00.000001+00:00";

function fakeResponse(payload) {
  return { ok: true, status: 200, json: async () => payload };
}

function makeRealtimeClient(roomId, { emitWake = true } = {}) {
  let listener = null;
  let configuration = null;
  let channelName = null;
  let removed = 0;
  let channelCalls = 0;
  const channel = {
    on(event, options, callback) {
      configuration = { event, options };
      listener = callback;
      return channel;
    },
    subscribe(statusCallback) {
      queueMicrotask(() => {
        statusCallback("SUBSCRIBED");
        if (emitWake) queueMicrotask(() => listener?.({ new: { room_id: roomId } }));
      });
      return channel;
    },
  };
  return {
    client: {
      channel(name) { channelCalls++; channelName = name; return channel; },
      async removeChannel(value) { assert.equal(value, channel); removed++; },
    },
    getStats() { return { configuration, channelName, removed, channelCalls }; },
  };
}

test("factory wires the MCP transport and room Realtime wake into the original-session bridge", async () => {
  const requests = [];
  const fakeFetch = async (url, options) => {
    const request = JSON.parse(options.body);
    requests.push({ url, options, request });
    const name = request.params.name;
    const args = request.params.arguments;
    let structuredContent;
    if (name === "read_group_messages") {
      structuredContent = {
        room_id: ROOM,
        participant_id: PARTICIPANT,
        messages: [{
          id: BASE_ID,
          room_id: ROOM,
          sender_id: OWNER_ID,
          body: "history before runner start",
          created_at: BASE_TIME,
          sender_kind: "human",
        }],
      };
    } else if (name === "wait_for_group_messages") {
      assert.equal(args.after_created_at, BASE_TIME);
      assert.equal(args.after_message_id, BASE_ID);
      assert.equal(args.limit, 1);
      structuredContent = {
        room_id: ROOM,
        participant_id: PARTICIPANT,
        timed_out: false,
        delivery: "realtime",
        messages: [{
          id: NEW_ID,
          room_id: ROOM,
          sender_id: OWNER_ID,
          body: "please collaborate",
          created_at: NEW_TIME,
          sender_kind: "human",
          sender_name: "Owner",
        }],
        next_cursor: { after_created_at: NEW_TIME, after_message_id: NEW_ID },
      };
    } else if (name === "send_group_message") {
      assert.equal(args.body, "Reply: please collaborate");
      assert.equal(args.source_message_id, NEW_ID);
      structuredContent = { room_id: ROOM, message_id: "40000000-0000-4000-8000-000000000004" };
    } else {
      throw new Error("Unexpected tool call: " + name);
    }
    return fakeResponse({
      jsonrpc: "2.0",
      id: request.id,
      result: { structuredContent },
    });
  };
  const realtime = makeRealtimeClient(ROOM);
  const prompts = [];
  const runtime = createOriginalSessionWakeRuntime({
    endpoint: ENDPOINT,
    sessionHandle: SESSION,
    participantId: PARTICIPANT,
    roomId: ROOM,
    page: { isClosed: () => false },
    adapter: { ask: async (_page, body, meta) => {
      prompts.push({ body, meta });
      return "Reply: " + body;
    } },
    supabaseClient: realtime.client,
    fetchImpl: fakeFetch,
    heartbeatMs: 1000,
    waitTimeoutMs: 1000,
    maxReplies: 1,
  });

  const result = await runtime.run({ approved: true });
  assert.deepEqual(result, { status: "limit_reached", replies: 1 });
  assert.deepEqual(prompts.map(prompt => prompt.body), ["please collaborate"]);
  assert.deepEqual(requests.map(item => item.request.params.name), [
    "read_group_messages",
    "wait_for_group_messages",
    "send_group_message",
  ]);
  assert.ok(requests.every(item => item.url === ENDPOINT && !item.url.includes(SESSION)));
  assert.ok(requests.every(item => item.request.params.arguments.session_handle === SESSION));
  assert.deepEqual(realtime.getStats().configuration, {
    event: "postgres_changes",
    options: { event: "INSERT", schema: "public", table: "messages", filter: "room_id=eq." + ROOM },
  });
  assert.equal(realtime.getStats().removed, 1);
});

test("factory refuses unapproved execution before touching the browser, network, or realtime source", async () => {
  let fetchCalls = 0;
  const realtime = makeRealtimeClient(ROOM, { emitWake: false });
  const runtime = createOriginalSessionWakeRuntime({
    endpoint: ENDPOINT,
    sessionHandle: SESSION,
    participantId: PARTICIPANT,
    roomId: ROOM,
    page: { isClosed: () => false },
    adapter: { ask: async () => "must not run" },
    supabaseClient: realtime.client,
    fetchImpl: async () => { fetchCalls++; throw new Error("network must not be reached"); },
  });
  await assert.rejects(() => runtime.run(), /Explicit approval required/);
  assert.equal(fetchCalls, 0);
  assert.equal(realtime.getStats().channelCalls, 0);
});
