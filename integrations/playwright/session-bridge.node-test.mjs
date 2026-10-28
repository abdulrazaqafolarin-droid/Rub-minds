import test from "node:test";
import assert from "node:assert/strict";
import { PlaywrightSessionBridge } from "./session-bridge.mjs";

function makeBridge({ messages = [], participantId = "self", roomId = "room-1", maxReplies = 10, maxMessagesPerStep = 1, maxMessageChars = 12000, allowAiHandoff = false, maxAiHandoffDepth = 2, maxSeenMessages = 5000 } = {}) {
  const calls = [];
  const sent = [];
  const bridge = new PlaywrightSessionBridge({
    page: { isClosed: () => false },
    participantId,
    roomId,
    maxReplies,
    maxMessagesPerStep,
    maxMessageChars,
    allowAiHandoff,
    maxAiHandoffDepth,
    maxSeenMessages,
    adapter: { ask: async (_page, body, meta) => { calls.push({ body, meta }); return "reply: " + body; } },
    readMessages: async () => ({ room_id: roomId, messages }),
    sendMessage: async (body, sourceMessageId) => { sent.push({ body, sourceMessageId }); return { ok: true }; },
  });
  return { bridge, calls, sent };
}

test("requires explicit approval before reading group messages", async () => {
  const { bridge, calls } = makeBridge({ messages: [{ id: "m1", body: "hello", sender_kind: "human" }] });
  await assert.rejects(() => bridge.step(), /Explicit approval/);
  assert.equal(calls.length, 0);
});

test("constructor requires one explicit group binding", () => {
  const base = {
    page: { isClosed: () => false },
    adapter: { ask: async () => "reply" },
    readMessages: async () => ({ room_id: "room-1", messages: [] }),
    sendMessage: async () => ({ ok: true }),
  };
  assert.throws(() => new PlaywrightSessionBridge(base), /roomId/);
  assert.throws(() => new PlaywrightSessionBridge({ ...base, roomId: " " }), /roomId/);
});

test("wrong-room and mixed-room message batches are rejected before provider access", async () => {
  const { bridge, calls, sent } = makeBridge({
    messages: [{ id: "should-not-run", body: "private task", sender_kind: "human" }],
  });
  bridge.readMessages = async () => ({ room_id: "room-2", messages: [{ id: "should-not-run", body: "private task", sender_kind: "human" }] });
  await assert.rejects(() => bridge.step({ approved: true }), /different Rub Minds room/);
  assert.equal(calls.length, 0);
  assert.equal(sent.length, 0);

  bridge.readMessages = async () => ({ room_id: "room-1", messages: [
    { id: "valid", body: "valid", sender_kind: "human", room_id: "room-1" },
    { id: "private", body: "other room", sender_kind: "human", room_id: "room-2" },
  ] });
  await assert.rejects(() => bridge.step({ approved: true }), /Cross-room message/);
  assert.equal(calls.length, 0, "entire mixed-room batches must be rejected before a provider effect");
  assert.equal(sent.length, 0);
});

test("defaults to human-origin messages and ignores its own and other AI messages", async () => {
  const { bridge, calls, sent } = makeBridge({
    messages: [
      { id: "own", body: "my previous reply", sender_id: "self", sender_kind: "original_session", turn_depth: 0 },
      { id: "human-1", body: "We need a launch plan", sender_id: "human-1", sender_kind: "human" },
      { id: "ai-1", body: "I suggest a staged rollout", sender_id: "ai-2", sender_kind: "external_agent", display_name: "Research AI", turn_depth: 1 },
    ],
    maxMessagesPerStep: 2,
  });
  const result = await bridge.step({ approved: true });
  assert.equal(result.sent, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body, "We need a launch plan");
  assert.equal(calls[0].meta.senderKind, "human");
  assert.deepEqual(sent.map(item => item.sourceMessageId), ["human-1"]);
});

test("AI-to-AI handoff only runs when enabled and within an explicit server turn-depth cap", async () => {
  const { bridge, calls, sent } = makeBridge({
    allowAiHandoff: true,
    maxAiHandoffDepth: 2,
    maxMessagesPerStep: 5,
    messages: [
      { id: "ai-allowed", body: "bounded AI contribution", sender_id: "ai-2", sender_kind: "external_agent", turn_depth: 1 },
      { id: "ai-at-cap", body: "too deep", sender_id: "ai-3", sender_kind: "model", turn_depth: 2 },
      { id: "ai-without-depth", body: "missing depth", sender_id: "ai-4", sender_kind: "original_session" },
      { id: "human", body: "fresh human task", sender_id: "human-1", sender_kind: "human" },
      { id: "unknown", body: "system event", sender_id: "system", sender_kind: "system", turn_depth: 0 },
    ],
  });
  const result = await bridge.step({ approved: true });
  assert.equal(result.sent, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body, "bounded AI contribution");
  assert.equal(calls[1].body, "fresh human task");
  assert.deepEqual(sent.map(item => item.sourceMessageId), ["ai-allowed", "human"]);
});

test("constructor rejects unbounded or ill-typed AI handoff settings", async () => {
  const base = {
    page: { isClosed: () => false },
    roomId: "room-1",
    adapter: { ask: async () => "reply" },
    readMessages: async () => ({ room_id: "room-1", messages: [] }),
    sendMessage: async () => ({ ok: true }),
  };
  assert.throws(() => new PlaywrightSessionBridge({ ...base, allowAiHandoff: "yes" }), /allowAiHandoff/);
  assert.throws(() => new PlaywrightSessionBridge({ ...base, maxAiHandoffDepth: 9 }), /maxAiHandoffDepth/);
  assert.throws(() => new PlaywrightSessionBridge({ ...base, maxAiHandoffDepth: 0 }), /maxAiHandoffDepth/);
  assert.throws(() => new PlaywrightSessionBridge({ ...base, maxSeenMessages: 0 }), /maxSeenMessages/);
  assert.throws(() => new PlaywrightSessionBridge({ ...base, maxSeenMessages: 100001 }), /maxSeenMessages/);
});

test("oversized group messages stop before provider access and require review", async () => {
  const { bridge, calls } = makeBridge({
    maxMessageChars: 12,
    messages: [
      { id: "too-large", body: "x".repeat(13), sender_kind: "human" },
      { id: "next", body: "short", sender_kind: "human" },
    ],
  });
  const result = await bridge.step({ approved: true });
  assert.equal(result.status, "message_too_large");
  assert.equal(result.messageId, "too-large");
  assert.equal(calls.length, 0);
  assert.equal(bridge.seen.has("too-large"), true, "oversized input should not be retried automatically");
});

test("constructor rejects unsafe message-size limits", () => {
  const base = {
    page: { isClosed: () => false },
    roomId: "room-1",
    adapter: { ask: async () => "reply" },
    readMessages: async () => ({ room_id: "room-1", messages: [] }),
    sendMessage: async () => ({ ok: true }),
  };
  assert.throws(() => new PlaywrightSessionBridge({ ...base, maxMessageChars: 0 }), /maxMessageChars/);
  assert.throws(() => new PlaywrightSessionBridge({ ...base, maxMessageChars: 50001 }), /maxMessageChars/);
});

test("seen-message budget stops safely instead of allowing unbounded dedupe growth", async () => {
  const { bridge, calls, sent } = makeBridge({
    maxMessagesPerStep: 10,
    maxSeenMessages: 2,
    messages: [
      { id: "human-1", body: "one reply is allowed", sender_kind: "human" },
      { id: "ignored-system", body: "ignored event", sender_kind: "system" },
      { id: "human-2", body: "must not start after cap", sender_kind: "human" },
    ],
  });
  const result = await bridge.step({ approved: true });
  assert.equal(result.status, "seen_budget_reached");
  assert.equal(bridge.seen.size, 2, "the dedupe set must not grow beyond its configured cap");
  assert.equal(result.sent, 1);
  assert.equal(calls.length, 1);
  assert.equal(sent.length, 1);
  assert.match(result.reason, /review session state/);
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
  assert.deepEqual(await bridge.step({ approved: true, remainingReplies: 0 }), { status: "limit_reached" });
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

test("durable message IDs count as explicit delivery acknowledgements", async () => {
  for (const receipt of [{ id: "db-row-1" }, { message_id: "db-message-2", duplicate: false }, { messageId: "db-message-3" }]) {
    const { bridge, calls, sent } = makeBridge({
      messages: [{ id: "incoming", body: "reply once", sender_kind: "human" }],
    });
    bridge.sendMessage = async (body, sourceMessageId) => {
      sent.push({ body, sourceMessageId });
      return receipt;
    };
    const outcome = await bridge.step({ approved: true });
    assert.equal(outcome.sent, 1);
    assert.equal(outcome.status, "ok");
    assert.equal(bridge.replies, 1);
    assert.equal(calls.length, 1);
    assert.equal(sent.length, 1);
  }
});

test("an ambiguous group-send failure does not re-run the provider or invite duplicate replies", async () => {
  const { bridge, calls, sent } = makeBridge({
    maxMessagesPerStep: 2,
    messages: [{ id: "ambiguous-send", body: "submit once", sender_kind: "human" }],
  });
  let sendAttempts = 0;
  bridge.sendMessage = async (body, sourceMessageId) => {
    sendAttempts++;
    // Simulate a server that accepted the reply but lost its HTTP response.
    sent.push({ body, sourceMessageId });
    throw new Error("connection reset after commit");
  };

  const first = await bridge.step({ approved: true });
  assert.equal(first.status, "send_outcome_ambiguous");
  assert.equal(first.messageId, "ambiguous-send");
  assert.equal(calls.length, 1, "provider is asked only once before the ambiguous delivery");
  assert.equal(sendAttempts, 1);
  assert.equal(bridge.seen.has("ambiguous-send"), true, "keep the source ID to prevent a second provider call");

  const second = await bridge.step({ approved: true });
  assert.deepEqual(second, { status: "ok", sent: 0, processed: 0 });
  assert.equal(calls.length, 1);
  assert.equal(sendAttempts, 1);
  assert.equal(sent.length, 1, "the simulated accepted reply must not be duplicated");
});

test("the transport must explicitly acknowledge delivery before the bridge counts a reply", async () => {
  for (const deliveryResult of [undefined, false, { ok: false }, { status: "queued" }]) {
    const { bridge, calls, sent } = makeBridge({
      messages: [{ id: "no-ack", body: "send me", sender_kind: "human" }],
    });
    bridge.sendMessage = async (body, sourceMessageId) => {
      sent.push({ body, sourceMessageId });
      return deliveryResult;
    };
    const outcome = await bridge.step({ approved: true });
    assert.equal(outcome.status, "send_outcome_ambiguous");
    assert.equal(bridge.replies, 0, "unacknowledged sends must not increase the confirmed-reply counter");
    assert.equal(bridge.seen.has("no-ack"), true);
    await bridge.step({ approved: true });
    assert.equal(calls.length, 1, "an unacknowledged send must not re-run provider work");
    assert.equal(sent.length, 1);
  }
});

test("automatic run bootstraps existing room history instead of replaying it", async () => {
  const { bridge, calls, sent } = makeBridge({ maxReplies: 1 });
  let reads = 0;
  bridge.readMessages = async () => ({
    room_id: "room-1",
    messages: reads++ === 0
      ? [{ id: "prior", body: "answer this old task", sender_kind: "human" }]
      : [
          { id: "prior", body: "answer this old task", sender_kind: "human" },
          { id: "fresh", body: "answer the new task", sender_kind: "human" },
        ],
  });
  await bridge.run({ approved: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body, "answer the new task");
  assert.deepEqual(sent.map(item => item.sourceMessageId), ["fresh"]);
  assert.equal(bridge.seen.has("prior"), true);
  assert.equal(bridge.seen.has("fresh"), true);
});

test("automatic run stops when its starting history exceeds the dedupe budget", async () => {
  const { bridge, calls } = makeBridge({
    maxSeenMessages: 1,
    messages: [
      { id: "history-1", body: "old 1", sender_kind: "human" },
      { id: "history-2", body: "old 2", sender_kind: "human" },
    ],
  });
  const result = await bridge.run({ approved: true });
  assert.equal(result, undefined);
  assert.equal(bridge.running, false);
  assert.equal(calls.length, 0);
  assert.equal(bridge.seen.size, 1);
});

test("the polling loop stops immediately on ambiguous reply delivery", async () => {
  const { bridge, calls } = makeBridge({ maxReplies: 5 });
  let reads = 0;
  bridge.readMessages = async () => ({
    room_id: "room-1",
    messages: reads++ === 0
      ? [{ id: "old-history", body: "old", sender_kind: "human" }]
      : [
          { id: "old-history", body: "old", sender_kind: "human" },
          { id: "ambiguous-loop", body: "only once", sender_kind: "human" },
        ],
  });
  bridge.sendMessage = async () => { throw new Error("response may already have committed"); };
  await bridge.run({ approved: true });
  assert.equal(bridge.running, false);
  assert.equal(calls.length, 1, "ambiguous delivery must stop the loop before provider re-execution");
  assert.equal(calls[0].body, "only once");
  assert.equal(bridge.seen.has("old-history"), true);
  assert.equal(bridge.seen.has("ambiguous-loop"), true);
});

test("retries a message after a transient provider failure", async () => {
  const { bridge, sent } = makeBridge({ messages: [{ id: "retry-me", body: "continue", sender_kind: "human" }] });
  let attempts = 0;
  bridge.adapter.ask = async () => {
    attempts++;
    if (attempts === 1) throw new Error("temporary provider failure");
    return "recovered reply";
  };
  await assert.rejects(() => bridge.step({ approved: true }), /temporary provider failure/);
  const result = await bridge.step({ approved: true });
  assert.equal(result.sent, 1);
  assert.equal(attempts, 2);
  assert.equal(sent.length, 1);
});
