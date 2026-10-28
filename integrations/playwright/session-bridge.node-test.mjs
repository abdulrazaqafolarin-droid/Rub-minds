import test from "node:test";
import assert from "node:assert/strict";
import { PlaywrightSessionBridge } from "./session-bridge.mjs";

function makeBridge({ messages = [], participantId = "self", maxReplies = 10, maxMessagesPerStep = 1, allowAiHandoff = false, maxAiHandoffDepth = 2, maxSeenMessages = 5000 } = {}) {
  const calls = [];
  const sent = [];
  const bridge = new PlaywrightSessionBridge({
    page: { isClosed: () => false },
    participantId,
    maxReplies,
    maxMessagesPerStep,
    allowAiHandoff,
    maxAiHandoffDepth,
    maxSeenMessages,
    adapter: { ask: async (_page, body, meta) => { calls.push({ body, meta }); return "reply: " + body; } },
    readMessages: async () => ({ messages }),
    sendMessage: async (body, sourceMessageId) => { sent.push({ body, sourceMessageId }); return { ok: true }; },
  });
  return { bridge, calls, sent };
}

test("requires explicit approval before reading group messages", async () => {
  const { bridge, calls } = makeBridge({ messages: [{ id: "m1", body: "hello", sender_kind: "human" }] });
  await assert.rejects(() => bridge.step(), /Explicit approval/);
  assert.equal(calls.length, 0);
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
    adapter: { ask: async () => "reply" },
    readMessages: async () => ({ messages: [] }),
    sendMessage: async () => {},
  };
  assert.throws(() => new PlaywrightSessionBridge({ ...base, allowAiHandoff: "yes" }), /allowAiHandoff/);
  assert.throws(() => new PlaywrightSessionBridge({ ...base, maxAiHandoffDepth: 9 }), /maxAiHandoffDepth/);
  assert.throws(() => new PlaywrightSessionBridge({ ...base, maxAiHandoffDepth: 0 }), /maxAiHandoffDepth/);
  assert.throws(() => new PlaywrightSessionBridge({ ...base, maxSeenMessages: 0 }), /maxSeenMessages/);
  assert.throws(() => new PlaywrightSessionBridge({ ...base, maxSeenMessages: 100001 }), /maxSeenMessages/);
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
