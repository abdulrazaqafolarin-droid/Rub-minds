import test from "node:test";
import assert from "node:assert/strict";
import { PlaywrightSessionBridge } from "./session-bridge.mjs";

function makeBridge({ messages = [], participantId = "self", maxReplies = 10, maxMessagesPerStep = 1 } = {}) {
  const calls = [];
  const sent = [];
  const bridge = new PlaywrightSessionBridge({
    page: { isClosed: () => false },
    participantId,
    maxReplies,
    maxMessagesPerStep,
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
