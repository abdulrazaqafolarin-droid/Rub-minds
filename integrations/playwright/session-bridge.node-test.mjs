import { compareMessageCursors } from "../mcp/protocol.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { PlaywrightSessionBridge } from "./session-bridge.mjs";

function makeBridge({
  messages = [], participantId = "self", maxReplies = 10,
  maxMessagesPerStep = 1, processExistingMessages = true, maxSeenMessageIds = 2000,
} = {}) {
  const calls = [];
  const sent = [];
  const bridge = new PlaywrightSessionBridge({
    page: { isClosed: () => false },
    participantId,
    maxReplies,
    maxMessagesPerStep,
    processExistingMessages,
    maxSeenMessageIds,
    adapter: { ask: async (_page, body, meta) => { calls.push({ body, meta }); return "reply: " + body; } },
    readMessages: async () => ({ messages }),
    sendMessage: async (body, sourceMessageId) => { sent.push({ body, sourceMessageId }); return { ok: true }; },
  });
  return { bridge, calls, sent };
}


test("startup baseline ignores pre-existing messages while later messages remain eligible", async () => {
  const history = [{ id: "old-1", body: "old question", sender_kind: "human" }];
  let messages = [...history];
  const calls = [];
  const sent = [];
  const bridge = new PlaywrightSessionBridge({
    page: { isClosed: () => false },
    participantId: "self",
    adapter: { ask: async (_page, body, meta) => { calls.push({ body, meta }); return "reply: " + body; } },
    readMessages: async () => ({ messages: [...messages] }),
    sendMessage: async (body, sourceMessageId) => { sent.push({ body, sourceMessageId }); },
  });

  const baseline = await bridge.initialize({ approved: true });
  assert.deepEqual(baseline, { status: "baseline", baselineMessages: 1 });
  const oldOnly = await bridge.step({ approved: true });
  assert.equal(oldOnly.sent, 0);
  assert.equal(calls.length, 0);

  messages = [...history, { id: "new-2", body: "new question", sender_kind: "human" }];
  const fresh = await bridge.step({ approved: true });
  assert.equal(fresh.sent, 1);
  assert.deepEqual(calls.map(call => call.body), ["new question"]);
  assert.deepEqual(sent.map(item => item.sourceMessageId), ["new-2"]);
});

test("processing startup history is an explicit option", async () => {
  const { bridge, calls, sent } = makeBridge({
    processExistingMessages: true,
    messages: [{ id: "history-1", body: "process this backlog", sender_kind: "human" }],
  });
  const result = await bridge.step({ approved: true });
  assert.equal(result.sent, 1);
  assert.equal(calls[0].body, "process this backlog");
  assert.equal(sent[0].sourceMessageId, "history-1");
});

test("explicit backlog mode starts at the epoch cursor and pages older history", async () => {
  const history = [
    { id: "10000000-0000-4000-8000-000000000001", body: "oldest backlog row", sender_kind: "human", sender_id: "owner", created_at: "2020-01-01T00:00:00.000000Z" },
    { id: "10000000-0000-4000-8000-000000000002", body: "second backlog row", sender_kind: "human", sender_id: "owner", created_at: "2020-01-02T00:00:00.000000Z" },
  ];
  const reads = [];
  const sent = [];
  const prompts = [];
  const bridge = new PlaywrightSessionBridge({
    page: { isClosed: () => false },
    participantId: "self",
    processExistingMessages: true,
    maxMessagesPerStep: 1,
    adapter: { ask: async (_page, body) => { prompts.push(body); return "reply: " + body; } },
    readMessages: async options => {
      reads.push(options);
      const cursor = options.cursor
        ? { id: options.cursor.after_message_id, created_at: options.cursor.after_created_at }
        : { id: "00000000-0000-1000-8000-000000000000", created_at: "1970-01-01T00:00:00.000Z" };
      return { messages: history.filter(message => compareMessageCursors(message, cursor) > 0) };
    },
    sendMessage: async (body, sourceMessageId) => { sent.push({ body, sourceMessageId }); return { ok: true }; },
  });

  await bridge.initialize({ approved: true });
  assert.deepEqual(bridge.cursor, {
    id: "00000000-0000-1000-8000-000000000000",
    created_at: "1970-01-01T00:00:00.000Z",
  });
  assert.equal((await bridge.step({ approved: true })).sent, 1);
  assert.equal(bridge.cursor.id, history[0].id);
  assert.equal((await bridge.step({ approved: true })).sent, 1);
  assert.equal(bridge.cursor.id, history[1].id);
  assert.deepEqual(prompts, ["oldest backlog row", "second backlog row"]);
  assert.deepEqual(sent.map(item => item.sourceMessageId), history.map(item => item.id));
  assert.deepEqual(reads.map(item => item.cursor), [
    { after_created_at: "1970-01-01T00:00:00.000Z", after_message_id: "00000000-0000-1000-8000-000000000000" },
    { after_created_at: "2020-01-01T00:00:00.000000Z", after_message_id: history[0].id },
  ]);
});

test("seen-message memory stays bounded and evicts oldest IDs first", () => {
  const { bridge } = makeBridge({ maxSeenMessageIds: 50, messages: [] });
  for (let i = 0; i < 100; i++) bridge.markSeen("message-" + i);
  assert.equal(bridge.seen.size, 50);
  assert.equal(bridge.seen.has("message-0"), false);
  assert.equal(bridge.seen.has("message-49"), false);
  assert.equal(bridge.seen.has("message-50"), true);
  assert.equal(bridge.seen.has("message-99"), true);
});


test("concurrent bridge steps fail fast instead of prompting the same message twice", async () => {
  let enteredRead;
  let releaseRead;
  const readEntered = new Promise(resolve => { enteredRead = resolve; });
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  const calls = [];
  const sent = [];
  const bridge = new PlaywrightSessionBridge({
    page: { isClosed: () => false },
    participantId: "self",
    processExistingMessages: true,
    adapter: { ask: async (_page, body) => { calls.push(body); return "reply: " + body; } },
    readMessages: async () => {
      enteredRead();
      await readGate;
      return { messages: [{ id: "only-once", body: "message", sender_kind: "human" }] };
    },
    sendMessage: async (body, sourceMessageId) => { sent.push({ body, sourceMessageId }); },
  });

  const first = bridge.step({ approved: true });
  await readEntered;
  const second = await bridge.step({ approved: true });
  assert.deepEqual(second, { status: "busy", sent: 0, processed: 0 });
  releaseRead();
  const firstResult = await first;
  assert.equal(firstResult.sent, 1);
  assert.deepEqual(calls, ["message"]);
  assert.deepEqual(sent, [{ body: "reply: message", sourceMessageId: "only-once" }]);
});


test("requires a participant identity so replies cannot be sent without self-filtering", () => {
  assert.throws(() => new PlaywrightSessionBridge({
    page: { isClosed: () => false },
    adapter: { ask: async () => "answer" },
    readMessages: async () => ({ messages: [] }),
    sendMessage: async () => ({ ok: true }),
  }), /participantId is required/);
});

test("retries an explicitly rejected group-send acknowledgement without asking the provider twice", async () => {
  let askCount = 0;
  let sendCount = 0;
  const delivered = [];
  const bridge = new PlaywrightSessionBridge({
    page: { isClosed: () => false },
    participantId: "self",
    processExistingMessages: true,
    adapter: { ask: async () => { askCount++; return "one answer"; } },
    readMessages: async () => ({ messages: [
      { id: "ack-message", body: "question", sender_id: "human-1", sender_kind: "human" },
    ] }),
    sendMessage: async (body, sourceMessageId) => {
      sendCount++;
      if (sendCount === 1) return { ok: false, error: "temporary transport rejection" };
      delivered.push({ body, sourceMessageId });
      return { ok: true };
    },
  });
  await assert.rejects(() => bridge.step({ approved: true }), /rejected group reply delivery/);
  assert.equal(bridge.pendingResponses.has("ack-message"), true);
  const retry = await bridge.step({ approved: true });
  assert.equal(retry.sent, 1);
  assert.equal(askCount, 1);
  assert.equal(sendCount, 2);
  assert.deepEqual(delivered, [{ body: "one answer", sourceMessageId: "ack-message" }]);
});

test("stop aborts a standalone bridge run and preserves its completed answer for later delivery", async () => {
  let entered;
  const enteredAsk = new Promise(resolve => { entered = resolve; });
  const sent = [];
  const bridge = new PlaywrightSessionBridge({
    page: { isClosed: () => false },
    participantId: "self",
    processExistingMessages: true,
    adapter: { ask: async (_page, _body, metadata) => {
      entered();
      await new Promise(resolve => metadata.signal.addEventListener("abort", resolve, { once: true }));
      return "provider finished just as stop was requested";
    } },
    readMessages: async () => ({ messages: [
      { id: "stop-message", body: "question", sender_id: "human-1", sender_kind: "human" },
    ] }),
    sendMessage: async (body, sourceMessageId) => { sent.push({ body, sourceMessageId }); return { ok: true }; },
    intervalMs: 1000,
  });
  const running = bridge.run({ approved: true });
  await enteredAsk;
  bridge.stop();
  assert.deepEqual(await running, { status: "stopped", replies: 0 });
  assert.equal(sent.length, 0);
  assert.equal(bridge.pendingResponses.has("stop-message"), true);
});

test("startup baseline uses a history limit independent of the per-step reply cap", async () => {
  const history = Array.from({ length: 12 }, (_, i) => ({
    id: "history-" + String(i + 1).padStart(2, "0"),
    body: "old history " + (i + 1),
    created_at: new Date(Date.UTC(2026, 9, 24, 17, 0, i + 1)).toISOString(),
    sender_kind: "human",
  }));
  const readOptions = [];
  const prompts = [];
  const bridge = new PlaywrightSessionBridge({
    page: { isClosed: () => false },
    participantId: "self",
    maxMessagesPerStep: 1,
    adapter: { ask: async (_page, body) => { prompts.push(body); return "answer"; } },
    readMessages: async options => {
      readOptions.push(options);
      if (options.baseline) return { messages: history.slice(-5) }; // mimic latest-page history API
      const cursor = options.cursor
        ? { id: options.cursor.after_message_id, created_at: options.cursor.after_created_at }
        : null;
      return { messages: cursor ? history.filter(message => compareMessageCursors(message, cursor) > 0) : history };
    },
    sendMessage: async () => ({ ok: true }),
  });

  const result = await bridge.initialize({ approved: true });
  assert.equal(result.status, "baseline");
  assert.equal(readOptions[0].baseline, true);
  assert.equal(readOptions[0].limit, 100);
  assert.equal(bridge.cursor.id, "history-12");
  assert.equal(bridge.seen.size, 5);
  const step = await bridge.step({ approved: true });
  assert.equal(step.sent, 0);
  assert.deepEqual(prompts, []);
});

test("an empty startup snapshot preserves its sentinel cursor for the first message", async () => {
  const sentinel = {
    after_created_at: "1970-01-01T00:00:00.000Z",
    after_message_id: "00000000-0000-1000-8000-000000000000",
  };
  const reads = [];
  const sent = [];
  const bridge = new PlaywrightSessionBridge({
    page: { isClosed: () => false },
    participantId: "self",
    adapter: { ask: async (_page, body) => "reply: " + body },
    readMessages: async options => {
      reads.push(options);
      if (options.baseline) return { messages: [], next_cursor: sentinel };
      return { messages: [{
        id: "20000000-0000-4000-8000-000000000002",
        body: "first message in room",
        sender_id: "human",
        sender_kind: "human",
        created_at: "2026-10-24T17:00:00.000001Z",
      }] };
    },
    sendMessage: async (body, sourceMessageId) => { sent.push({ body, sourceMessageId }); },
  });
  const initialized = await bridge.initialize({ approved: true });
  assert.deepEqual(initialized, { status: "baseline", baselineMessages: 0 });
  assert.deepEqual(bridge.cursor, {
    id: sentinel.after_message_id,
    created_at: sentinel.after_created_at,
  });
  const result = await bridge.step({ approved: true });
  assert.equal(result.sent, 1);
  assert.deepEqual(reads[1].cursor, sentinel);
  assert.deepEqual(sent, [{
    body: "reply: first message in room",
    sourceMessageId: "20000000-0000-4000-8000-000000000002",
  }]);
});

test("baseline stores a composite cursor and supplies it to the next durable message read", async () => {
  const messages = [
    { id: "message-01", body: "older", created_at: "2026-10-24T17:00:00.123455+00:00", sender_kind: "human" },
    { id: "message-02", body: "latest existing", created_at: "2026-10-24T17:00:00.123456+00:00", sender_kind: "human" },
  ];
  const reads = [];
  const sent = [];
  const bridge = new PlaywrightSessionBridge({
    page: { isClosed: () => false },
    participantId: "self",
    adapter: { ask: async (_page, body) => "reply: " + body },
    readMessages: async options => {
      reads.push(options);
      if (!options.cursor) return { messages };
      return { messages: [{ id: "message-03", body: "new after baseline", created_at: "2026-10-24T17:00:00.123457+00:00", sender_kind: "human" }] };
    },
    sendMessage: async (body, sourceMessageId) => { sent.push({ body, sourceMessageId }); },
  });

  assert.deepEqual(await bridge.initialize({ approved: true }), { status: "baseline", baselineMessages: 2 });
  assert.deepEqual(bridge.cursor, {
    id: "message-02",
    created_at: "2026-10-24T17:00:00.123456+00:00",
  });
  const result = await bridge.step({ approved: true });
  assert.equal(result.sent, 1);
  assert.deepEqual(reads[1].cursor, {
    after_created_at: "2026-10-24T17:00:00.123456+00:00",
    after_message_id: "message-02",
  });
  assert.deepEqual(sent, [{ body: "reply: new after baseline", sourceMessageId: "message-03" }]);
  assert.deepEqual(bridge.cursor, {
    id: "message-03",
    created_at: "2026-10-24T17:00:00.123457+00:00",
  });
});

test("durable pre-prompt claims prevent concurrent bridge instances asking the provider twice", async () => {
  const initial = {
    revision: 0,
    cursor: {
      after_created_at: "2026-10-24T17:00:00.000000Z",
      after_message_id: "10000000-0000-4000-8000-000000000001",
    },
    pending_response: null,
    blocked_message: null,
  };
  let loads = 0;
  let releaseLoads;
  const bothLoaded = new Promise(resolve => { releaseLoads = resolve; });
  let current = structuredClone(initial);
  const stateStore = {
    load: async () => {
      loads++;
      const snapshot = structuredClone(initial);
      if (loads === 2) releaseLoads();
      await bothLoaded;
      return snapshot;
    },
    save: async snapshot => {
      if (snapshot.expected_revision !== current.revision) {
        return { saved: false, conflict: true, revision: current.revision };
      }
      current = {
        revision: current.revision + 1,
        cursor: snapshot.cursor,
        pending_response: snapshot.pending_response,
        blocked_message: snapshot.blocked_message,
      };
      return { saved: true, conflict: false, revision: current.revision };
    },
  };
  let askCalls = 0;
  const sent = [];
  const makeBridge = () => new PlaywrightSessionBridge({
    page: { isClosed: () => false },
    participantId: "self",
    adapter: { ask: async () => { askCalls++; return "single answer"; } },
    readMessages: async () => ({
      messages: [{
        id: "20000000-0000-4000-8000-000000000002",
        body: "shared question",
        sender_id: "human",
        sender_kind: "human",
        created_at: "2026-10-24T17:00:00.000001Z",
      }],
    }),
    sendMessage: async (body, sourceMessageId) => {
      sent.push({ body, sourceMessageId });
      return { ok: true };
    },
    stateStore,
  });
  const first = makeBridge();
  const second = makeBridge();
  const outcomes = await Promise.allSettled([
    first.step({ approved: true }),
    second.step({ approved: true }),
  ]);
  assert.equal(askCalls, 1, "only the bridge that wins the durable claim may ask the provider");
  assert.equal(sent.length, 1, "only one bridge may send the completed response");
  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(outcome => outcome.status === "rejected").length, 1);
  assert.equal(current.cursor.after_message_id, "20000000-0000-4000-8000-000000000002");
  assert.equal(current.pending_response, null);
  assert.equal(current.blocked_message, null);
});

test("direct step honours a durable provider-prompt block restored during initialization", async () => {
  let reads = 0;
  let asks = 0;
  const bridge = new PlaywrightSessionBridge({
    page: { isClosed: () => false },
    participantId: "self",
    adapter: { ask: async () => { asks++; return "must not run"; } },
    readMessages: async () => { reads++; return { messages: [] }; },
    sendMessage: async () => ({ ok: true }),
    stateStore: {
      load: async () => ({
        revision: 3,
        cursor: {
          after_created_at: "2026-10-24T17:00:00.000000Z",
          after_message_id: "10000000-0000-4000-8000-000000000001",
        },
        pending_response: null,
        blocked_message: {
          message_id: "20000000-0000-4000-8000-000000000002",
          reason: "provider_prompt_in_progress",
        },
      }),
      save: async () => { throw new Error("blocked state must stop before another save"); },
    },
  });
  const result = await bridge.step({ approved: true });
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "provider_prompt_in_progress");
  assert.equal(reads, 0);
  assert.equal(asks, 0);
});

test("restarts from a durable pending answer without prompting the provider again", async () => {
  let state = {
    revision: 5,
    cursor: {
      after_created_at: "2026-10-24T17:00:00.000000Z",
      after_message_id: "10000000-0000-4000-8000-000000000001",
    },
    pending_response: {
      source_message_id: "20000000-0000-4000-8000-000000000002",
      message_created_at: "2026-10-24T17:00:00.000001Z",
      body: "answer saved before crash",
    },
    blocked_message: null,
  };
  const saves = [];
  const stateStore = {
    load: async () => structuredClone(state),
    save: async snapshot => {
      assert.equal(snapshot.expected_revision, state.revision);
      state = {
        revision: state.revision + 1,
        cursor: snapshot.cursor,
        pending_response: snapshot.pending_response,
        blocked_message: snapshot.blocked_message,
      };
      saves.push(snapshot);
      return { saved: true, conflict: false, revision: state.revision };
    },
  };
  let askCalls = 0;
  const sent = [];
  const bridge = new PlaywrightSessionBridge({
    page: { isClosed: () => false },
    participantId: "self",
    adapter: { ask: async () => { askCalls++; return "must not ask again"; } },
    readMessages: async () => ({ messages: [] }),
    sendMessage: async (body, sourceMessageId) => {
      sent.push({ body, sourceMessageId });
      return { ok: true };
    },
    stateStore,
  });
  const result = await bridge.step({ approved: true });
  assert.deepEqual(result, { status: "ok", sent: 1, processed: 0 });
  assert.equal(askCalls, 0);
  assert.deepEqual(sent, [{
    body: "answer saved before crash",
    sourceMessageId: "20000000-0000-4000-8000-000000000002",
  }]);
  assert.equal(state.cursor.after_message_id, "20000000-0000-4000-8000-000000000002");
  assert.equal(state.pending_response, null);
  assert.equal(state.blocked_message, null);
  assert.equal(state.revision, 6);
  assert.equal(saves.length, 1);
});

test("restores durable cursor state and avoids a fresh baseline that could skip messages", async () => {
  const stored = {
    revision: 7,
    cursor: { after_created_at: "2026-10-24T17:00:00.000000Z", after_message_id: "10000000-0000-4000-8000-000000000001" },
    pending_response: null,
    blocked_message: null,
  };
  let reads = 0;
  const saves = [];
  const stateStore = {
    load: async () => structuredClone(stored),
    save: async snapshot => {
      assert.equal(snapshot.expected_revision, stored.revision);
      stored.revision++;
      saves.push(snapshot);
      return { saved: true, conflict: false, revision: stored.revision };
    },
  };
  const bridge = new PlaywrightSessionBridge({
    page: { isClosed: () => false },
    participantId: "self",
    adapter: { ask: async () => "not needed" },
    readMessages: async () => { reads++; return { messages: [] }; },
    sendMessage: async () => ({ ok: true }),
    stateStore,
  });
  assert.deepEqual(await bridge.initialize({ approved: true }), {
    status: "ready", baselineMessages: 0, restored: true,
  });
  assert.equal(reads, 0);
  assert.deepEqual(bridge.cursor, {
    id: "10000000-0000-4000-8000-000000000001",
    created_at: "2026-10-24T17:00:00.000000Z",
  });
  assert.equal(saves.length, 0);
});

test("invalid message timestamps do not poison the composite cursor", () => {
  const { bridge } = makeBridge({ processExistingMessages: true, messages: [] });
  bridge.advanceCursor({ id: "invalid", created_at: "not-a-date" });
  assert.equal(bridge.cursor, null);
  bridge.advanceCursor({ id: "valid", created_at: "2026-10-24T17:00:00.000Z" });
  assert.deepEqual(bridge.cursor, { id: "valid", created_at: "2026-10-24T17:00:00.000Z" });
});

test("cursor paging resumes after the last successfully handled message", async () => {
  const allMessages = [
    { id: "page-02", body: "second", created_at: "2026-10-24T17:00:00.002000Z", sender_kind: "human" },
    { id: "page-01", body: "first", created_at: "2026-10-24T17:00:00.001000Z", sender_kind: "human" },
  ];
  const reads = [];
  const sent = [];
  const bridge = new PlaywrightSessionBridge({
    page: { isClosed: () => false },
    participantId: "self",
    processExistingMessages: true,
    maxMessagesPerStep: 1,
    adapter: { ask: async (_page, body) => "reply: " + body },
    readMessages: async options => {
      reads.push(options);
      const cursor = options.cursor;
      const remaining = cursor
        ? allMessages.filter(message => compareMessageCursors(message, {
            id: cursor.after_message_id,
            created_at: cursor.after_created_at,
          }) > 0)
        : allMessages;
      return { messages: remaining };
    },
    sendMessage: async (body, sourceMessageId) => { sent.push({ body, sourceMessageId }); },
  });

  assert.equal((await bridge.step({ approved: true })).sent, 1);
  assert.equal(bridge.cursor.id, "page-01");
  assert.equal((await bridge.step({ approved: true })).sent, 1);
  assert.equal(bridge.cursor.id, "page-02");
  assert.deepEqual(sent.map(item => item.sourceMessageId), ["page-01", "page-02"]);
  assert.deepEqual(reads[1].cursor, {
    after_created_at: "2026-10-24T17:00:00.001000Z",
    after_message_id: "page-01",
  });
});

test("partial provider failure does not advance the cursor past the failed message", async () => {
  const messages = [
    { id: "cursor-ok", body: "first", created_at: "2026-10-24T17:00:00.001000Z", sender_kind: "human" },
    { id: "cursor-fail", body: "second", created_at: "2026-10-24T17:00:00.002000Z", sender_kind: "human" },
  ];
  const bridge = new PlaywrightSessionBridge({
    page: { isClosed: () => false },
    participantId: "self",
    processExistingMessages: true,
    maxMessagesPerStep: 2,
    adapter: { ask: async (_page, body) => {
      if (body === "second") {
        const error = new Error("not submitted");
        error.safeToRetry = true;
        throw error;
      }
      return "first response";
    } },
    readMessages: async () => ({ messages }),
    sendMessage: async () => ({ ok: true }),
  });
  const result = await bridge.step({ approved: true, remainingReplies: 2 });
  assert.equal(result.status, "error");
  assert.equal(bridge.cursor.id, "cursor-ok");
});

test("requires explicit approval before reading group messages", async () => {
  const { bridge, calls } = makeBridge({ messages: [{ id: "m1", body: "hello", sender_kind: "human" }] });
  await assert.rejects(() => bridge.step(), /Explicit approval/);
  assert.equal(calls.length, 0);
});

test("allows natural human and AI-to-AI conversation, excluding its own messages", async () => {
  const { bridge, calls, sent } = makeBridge({
    messages: [
      { id: "own", body: "my previous reply", sender_id: "self", sender_kind: "original_session" },
      { id: "human-1", body: "We need a launch plan", sender_id: "human-1", sender_kind: "human" },
      { id: "ai-1", body: "I suggest a staged rollout", sender_id: "ai-2", sender_kind: "external_agent", display_name: "Research AI" },
    ],
    maxMessagesPerStep: 2,
  });
  const result = await bridge.step({ approved: true });
  assert.equal(result.sent, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body, "We need a launch plan");
  assert.equal(calls[1].body, "I suggest a staged rollout");
  assert.equal(calls[1].meta.senderName, "Research AI");
  assert.deepEqual(sent.map(item => item.sourceMessageId), ["human-1", "ai-1"]);
});

test("deduplicates previously seen message IDs across polling steps", async () => {
  const { bridge, calls } = makeBridge({ messages: [{ id: "m1", body: "hello", sender_kind: "human" }] });
  await bridge.step({ approved: true });
  await bridge.step({ approved: true });
  assert.equal(calls.length, 1);
});

test("respects coordinator remaining-reply budget", async () => {
  const { bridge, sent } = makeBridge({
    messages: [
      { id: "m1", body: "first", sender_kind: "human" },
      { id: "m2", body: "second", sender_kind: "external_agent" },
    ],
    maxMessagesPerStep: 2,
  });
  const result = await bridge.step({ approved: true, remainingReplies: 1 });
  assert.equal(result.sent, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(await bridge.step({ approved: true, remainingReplies: 0 }), { status: "limit_reached", sent: 0, processed: 0 });
});

test("does not reply to unknown sender kinds or excessive server-supplied turn depth", async () => {
  const { bridge, calls } = makeBridge({
    messages: [
      { id: "system", body: "system notice", sender_kind: "system" },
      { id: "deep", body: "deep loop", sender_kind: "model", turn_depth: 8 },
    ],
  });
  const result = await bridge.step({ approved: true });
  assert.equal(result.sent, 0);
  assert.equal(calls.length, 0);
});

test("retries a message after a transient provider failure", async () => {
  const { bridge, sent } = makeBridge({ messages: [{ id: "retry-me", body: "continue", sender_kind: "human" }] });
  let attempts = 0;
  bridge.adapter.ask = async () => {
    attempts++;
    if (attempts === 1) {
      const error = new Error("temporary provider failure");
      error.safeToRetry = true; // The adapter guarantees no prompt was submitted.
      throw error;
    }
    return "recovered reply";
  };
  await assert.rejects(() => bridge.step({ approved: true }), /temporary provider failure/);
  const result = await bridge.step({ approved: true });
  assert.equal(result.sent, 1);
  assert.equal(attempts, 2);
  assert.equal(sent.length, 1);
});


test("returns typed terminal results with integer sent counts", async () => {
  const { bridge } = makeBridge();
  bridge.page.isClosed = () => true;
  assert.deepEqual(await bridge.step({ approved: true }), {
    status: "browser_closed", sent: 0, processed: 0,
  });
});

test("an unclassified provider failure blocks instead of risking a duplicate prompt", async () => {
  const { bridge, calls } = makeBridge({
    messages: [{ id: "ambiguous", body: "send once", sender_kind: "human" }],
  });
  let attempts = 0;
  bridge.adapter.ask = async () => { attempts++; throw new Error("connection dropped during submission"); };
  const first = await bridge.step({ approved: true });
  assert.equal(first.status, "blocked");
  assert.equal(first.blockedMessageId, "ambiguous");
  const second = await bridge.step({ approved: true });
  assert.equal(second.status, "blocked");
  assert.equal(attempts, 1);
  assert.equal(calls.length, 0);
});

test("a failed group delivery retries the same saved provider response without asking twice", async () => {
  const message = { id: "m-pending", body: "question", sender_kind: "human" };
  const calls = { ask: 0, send: 0, delivered: [] };
  const bridge = new PlaywrightSessionBridge({
    page: { isClosed: () => false },
    participantId: "self",
    adapter: { ask: async () => { calls.ask++; return "answer"; } },
    readMessages: async () => ({ messages: [message] }),
    processExistingMessages: true,
    sendMessage: async (body, sourceMessageId) => {
      calls.send++;
      calls.delivered.push({ body, sourceMessageId });
      if (calls.send === 1) throw new Error("transport timed out after send");
      return { ok: true };
    },
  });
  await assert.rejects(() => bridge.step({ approved: true }), /transport timed out/);
  const result = await bridge.step({ approved: true });
  assert.equal(result.sent, 1);
  assert.equal(calls.ask, 1);
  assert.equal(calls.send, 2);
  assert.deepEqual(calls.delivered, [
    { body: "answer", sourceMessageId: "m-pending" },
    { body: "answer", sourceMessageId: "m-pending" },
  ]);
});

test("passes cancellation to the provider adapter and preserves an already-completed answer", async () => {
  let entered;
  const enteredAsk = new Promise(resolve => { entered = resolve; });
  const controller = new AbortController();
  const { bridge, sent } = makeBridge({ messages: [{ id: "cancel-m", body: "question", sender_kind: "human" }] });
  bridge.adapter.ask = async (_page, _body, meta) => {
    assert.equal(meta.signal, controller.signal);
    entered();
    await new Promise(resolve => meta.signal.addEventListener("abort", resolve, { once: true }));
    return "completed answer";
  };
  const pending = bridge.step({ approved: true, signal: controller.signal });
  await enteredAsk;
  controller.abort();
  assert.deepEqual(await pending, { status: "cancelled", sent: 0, processed: 1, pendingDelivery: true });
  const resent = await bridge.step({ approved: true });
  assert.equal(resent.sent, 1);
  assert.equal(sent.length, 1);
});


test("reports partial sends when a later message has a classified transient failure", async () => {
  const messages = [
    { id: "first", body: "one", sender_kind: "human" },
    { id: "second", body: "two", sender_kind: "human" },
  ];
  const sent = [];
  let attempts = 0;
  const bridge = new PlaywrightSessionBridge({
    page: { isClosed: () => false },
    participantId: "self",
    maxMessagesPerStep: 2,
    adapter: { ask: async (_page, body) => {
      attempts++;
      if (body === "two") {
        const error = new Error("provider temporarily unavailable");
        error.safeToRetry = true;
        throw error;
      }
      return "answer one";
    } },
    readMessages: async () => ({ messages }),
    processExistingMessages: true,
    sendMessage: async (body, sourceMessageId) => { sent.push({ body, sourceMessageId }); },
  });
  const result = await bridge.step({ approved: true, remainingReplies: 2 });
  assert.deepEqual(result, {
    status: "error",
    sent: 1,
    processed: 2,
    message: "provider temporarily unavailable",
  });
  assert.equal(bridge.replies, 1);
  assert.deepEqual(sent, [{ body: "answer one", sourceMessageId: "first" }]);
});


function makeDurableTestStore(snapshots) {
  return {
    load: async () => ({
      revision: 0,
      cursor: null,
      pending_response: null,
      blocked_message: null,
    }),
    save: async snapshot => {
      snapshots.push(structuredClone(snapshot));
      return { saved: true, conflict: false, revision: snapshot.expected_revision + 1 };
    },
  };
}

test("explicit approval denial stops this run without persisting an ambiguous blocker", async () => {
  const snapshots = [];
  const message = {
    id: "10000000-0000-4000-8000-000000000001",
    body: "please answer",
    sender_id: "human",
    sender_kind: "human",
    created_at: "2026-01-01T00:00:00.000Z",
  };
  const bridge = new PlaywrightSessionBridge({
    page: { isClosed: () => false },
    participantId: "self",
    processExistingMessages: true,
    adapter: {
      ask: async () => {
        const error = new Error("Original-session message not approved");
        error.code = "RUB_MINDS_APPROVAL_DENIED";
        error.submissionState = "not_submitted";
        throw error;
      },
    },
    readMessages: async () => ({ messages: [message] }),
    sendMessage: async () => { throw new Error("No answer should be sent after refusal"); },
    stateStore: makeDurableTestStore(snapshots),
  });

  const result = await bridge.step({ approved: true });
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "approval_denied");
  assert.equal(result.blockedMessageId, message.id);
  assert.equal(bridge.blockedMessage, null);
  assert.equal(snapshots.at(-1).blocked_message, null,
    "an explicit refusal must not persist the crash-recovery ambiguity marker");
});

test("pre-submit cancellation releases the claim instead of recording an ambiguous provider outcome", async () => {
  const snapshots = [];
  const controller = new AbortController();
  const message = {
    id: "10000000-0000-4000-8000-000000000002",
    body: "please answer",
    sender_id: "human",
    sender_kind: "human",
    created_at: "2026-01-02T00:00:00.000Z",
  };
  const bridge = new PlaywrightSessionBridge({
    page: { isClosed: () => false },
    participantId: "self",
    processExistingMessages: true,
    adapter: {
      ask: async (_page, _body, metadata) => {
        assert.equal(metadata.signal, controller.signal);
        controller.abort();
        const error = new Error("cancelled before submit");
        error.name = "AbortError";
        error.submissionState = "not_submitted";
        throw error;
      },
    },
    readMessages: async () => ({ messages: [message] }),
    sendMessage: async () => { throw new Error("No answer should be sent after cancellation"); },
    stateStore: makeDurableTestStore(snapshots),
  });

  const result = await bridge.step({ approved: true, signal: controller.signal });
  assert.equal(result.status, "cancelled");
  assert.equal(bridge.blockedMessage, null);
  assert.equal(snapshots.at(-1).blocked_message, null,
    "pre-submit cancellation must release the durable claim");
});
