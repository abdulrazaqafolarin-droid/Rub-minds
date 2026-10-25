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

test("seen-message memory stays bounded and evicts oldest IDs first", () => {
  const { bridge } = makeBridge({ maxSeenMessageIds: 50, messages: [] });
  for (let i = 0; i < 100; i++) bridge.markSeen("message-" + i);
  assert.equal(bridge.seen.size, 50);
  assert.equal(bridge.seen.has("message-0"), false);
  assert.equal(bridge.seen.has("message-49"), false);
  assert.equal(bridge.seen.has("message-50"), true);
  assert.equal(bridge.seen.has("message-99"), true);
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
