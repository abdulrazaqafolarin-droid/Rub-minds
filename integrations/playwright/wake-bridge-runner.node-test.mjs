import test from "node:test";
import assert from "node:assert/strict";
import { OriginalSessionWakeRunner } from "./wake-bridge-runner.mjs";
import { PlaywrightSessionBridge } from "./session-bridge.mjs";

test("requires explicit approval and a valid bridge/wake source", async () => {
  const runner = new OriginalSessionWakeRunner({
    bridge: { step: async () => ({ sent: 0 }) },
    wakeSource: { waitForWake: async () => ({ status: "timeout" }) },
  });
  await assert.rejects(() => runner.run(), /Explicit approval required/);
  assert.throws(() => new OriginalSessionWakeRunner({ bridge: {}, wakeSource: {} }), /bridge.step/);
});

test("wake events invoke the existing-session bridge and respect reply limits", async () => {
  let waits = 0;
  let steps = 0;
  const runner = new OriginalSessionWakeRunner({
    bridge: { step: async ({ approved, wakeReason, remainingReplies }) => {
      assert.equal(approved, true);
      assert.equal(wakeReason, "wake");
      assert.equal(remainingReplies, 2 - steps);
      steps++;
      return { status: "ok", sent: 1 };
    } },
    wakeSource: { waitForWake: async () => ({ status: ++waits <= 2 ? "wake" : "closed" }) },
    maxReplies: 2,
  });
  assert.deepEqual(await runner.run({ approved: true }), { status: "limit_reached", replies: 2 });
  assert.equal(steps, 2);
});

test("heartbeat timeout still checks durable messages to recover missed notifications", async () => {
  let wakeCount = 0;
  let stepCount = 0;
  const runner = new OriginalSessionWakeRunner({
    bridge: { step: async ({ wakeReason }) => { assert.equal(wakeReason, "timeout"); stepCount++; return { status: "ok", sent: 0 }; } },
    wakeSource: { waitForWake: async () => ({ status: ++wakeCount === 1 ? "timeout" : "closed" }) },
    heartbeatMs: 1000,
  });
  assert.deepEqual(await runner.run({ approved: true }), { status: "source_closed", replies: 0 });
  assert.equal(stepCount, 1);
});

test("aborting stops a pending wake wait", async () => {
  let entered;
  const enteredWait = new Promise(resolve => { entered = resolve; });
  const runner = new OriginalSessionWakeRunner({
    bridge: { step: async () => ({ sent: 0 }) },
    wakeSource: { waitForWake: ({ signal }) => new Promise(resolve => {
      entered();
      signal.addEventListener("abort", () => resolve({ status: "closed" }), { once: true });
    }) },
  });
  const controller = new AbortController();
  const result = runner.run({ approved: true, signal: controller.signal });
  await enteredWait;
  controller.abort();
  assert.deepEqual(await result, { status: "stopped", replies: 0 });
});

test("invalid wake statuses fail closed after bounded errors", async () => {
  const statuses = [];
  const runner = new OriginalSessionWakeRunner({
    bridge: { step: async () => ({ sent: 0 }) },
    wakeSource: { waitForWake: async () => ({ status: "unexpected" }) },
    maxConsecutiveErrors: 2,
    onStatus: event => statuses.push(event.status),
  });
  await assert.rejects(() => runner.run({ approved: true }), /invalid status/);
  assert.equal(statuses.filter(status => status === "error").length, 3); // two retry events plus final terminal status
});

test("stop aborts the active wait without needing a provider-specific selector", async () => {
  let entered;
  const enteredWait = new Promise(resolve => { entered = resolve; });
  const runner = new OriginalSessionWakeRunner({
    bridge: { step: async () => ({ sent: 0 }) },
    wakeSource: { waitForWake: ({ signal }) => new Promise(resolve => {
      entered();
      signal.addEventListener("abort", () => resolve({ status: "closed" }), { once: true });
    }) },
  });
  const result = runner.run({ approved: true });
  await enteredWait;
  runner.stop();
  assert.deepEqual(await result, { status: "stopped", replies: 0 });
});

test("starts and closes the injected wake source as part of runner lifecycle", async () => {
  const lifecycle = [];
  const runner = new OriginalSessionWakeRunner({
    bridge: { step: async () => ({ status: "ok", sent: 0 }) },
    wakeSource: {
      start: async () => { lifecycle.push("start"); },
      waitForWake: async () => ({ status: "closed" }),
      close: async () => { lifecycle.push("close"); },
    },
  });
  await runner.run({ approved: true });
  assert.deepEqual(lifecycle, ["start", "close"]);
});


test("a signal aborted before run prevents source startup and browser work", async () => {
  let started = 0;
  let stepped = 0;
  const runner = new OriginalSessionWakeRunner({
    bridge: { step: async () => { stepped++; return { status: "ok", sent: 0 }; } },
    wakeSource: {
      start: async () => { started++; },
      waitForWake: async () => ({ status: "closed" }),
      close: async () => {},
    },
  });
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await runner.run({ approved: true, signal: controller.signal }), { status: "stopped", replies: 0 });
  assert.equal(started, 0);
  assert.equal(stepped, 0);
});

test("passes cancellation into an in-flight bridge step", async () => {
  let entered;
  const enteredStep = new Promise(resolve => { entered = resolve; });
  const runner = new OriginalSessionWakeRunner({
    bridge: { step: ({ signal }) => new Promise(resolve => {
      assert.ok(signal instanceof AbortSignal);
      entered();
      signal.addEventListener("abort", () => resolve({ status: "cancelled", sent: 0 }), { once: true });
    }) },
    wakeSource: { waitForWake: async () => ({ status: "wake" }) },
  });
  const result = runner.run({ approved: true });
  await enteredStep;
  runner.stop();
  assert.deepEqual(await result, { status: "stopped", replies: 0 });
});

test("rejects an adapter reply count that exceeds the remaining cap", async () => {
  const runner = new OriginalSessionWakeRunner({
    bridge: { step: async () => ({ status: "ok", sent: 2 }) },
    wakeSource: { waitForWake: async () => ({ status: "wake" }) },
    maxReplies: 1,
    maxConsecutiveErrors: 1,
  });
  await assert.rejects(() => runner.run({ approved: true }), /invalid sent count/);
});

test("adapter error result counts toward the bounded failure threshold", async () => {
  let calls = 0;
  const runner = new OriginalSessionWakeRunner({
    bridge: { step: async () => { calls++; return { status: "error", sent: 0, message: "provider adapter unavailable" }; } },
    wakeSource: { waitForWake: async () => ({ status: "wake" }) },
    maxConsecutiveErrors: 2,
  });
  await assert.rejects(() => runner.run({ approved: true }), /provider adapter unavailable/);
  assert.equal(calls, 2);
});

test("fails closed on provider authorization or thread-state blockers", async () => {
  let calls = 0;
  const runner = new OriginalSessionWakeRunner({
    bridge: { step: async () => { calls++; return { status: "auth_required", sent: 0 }; } },
    wakeSource: { waitForWake: async () => ({ status: "wake" }) },
  });
  assert.deepEqual(await runner.run({ approved: true }), { status: "auth_required", replies: 0 });
  assert.equal(calls, 1);
});

test("runner instance cannot be reused after its wake source has been closed", async () => {
  const runner = new OriginalSessionWakeRunner({
    bridge: { step: async () => ({ status: "ok", sent: 0 }) },
    wakeSource: { waitForWake: async () => ({ status: "closed" }), close: async () => {} },
  });
  await runner.run({ approved: true });
  await assert.rejects(() => runner.run({ approved: true }), /single-use/);
});


test("subscription startup failure reports error and still cleans up", async () => {
  const statuses = [];
  let closed = 0;
  const runner = new OriginalSessionWakeRunner({
    bridge: { step: async () => ({ status: "ok", sent: 0 }) },
    wakeSource: {
      start: async () => { throw new Error("subscription handshake timeout"); },
      waitForWake: async () => ({ status: "closed" }),
      close: async () => { closed++; },
    },
    onStatus: event => statuses.push(event.status),
  });
  await assert.rejects(() => runner.run({ approved: true }), /subscription handshake timeout/);
  assert.equal(closed, 1);
  assert.equal(statuses.at(-1), "error");
});


test("wake runner establishes history baseline before subscribing and processes only new messages", async () => {
  const sent = [];
  const prompts = [];
  const history = [{
    id: "old-message", body: "old group history", sender_id: "human-1", sender_kind: "human",
  }];
  let messages = [...history];
  const sessionBridge = new PlaywrightSessionBridge({
    page: { isClosed: () => false },
    adapter: { ask: async (_page, body, metadata) => {
      prompts.push({ body, metadata });
      return "reply to: " + body;
    } },
    readMessages: async () => ({ messages: [...messages] }),
    sendMessage: async (body, sourceMessageId) => { sent.push({ body, sourceMessageId }); },
    maxReplies: 5,
  });
  let started = false;
  const runner = new OriginalSessionWakeRunner({
    bridge: sessionBridge,
    wakeSource: {
      start: async () => {
        started = true;
        // Simulate a group message arriving after the history baseline, during
        // the hand-off to the Realtime subscription.
        messages = [...history, {
          id: "message-42", body: "please collaborate", sender_id: "human-42", sender_kind: "human",
        }];
      },
      waitForWake: async () => ({ status: "wake" }),
      close: async () => {},
    },
    maxReplies: 1,
  });
  assert.deepEqual(await runner.run({ approved: true }), { status: "limit_reached", replies: 1 });
  assert.equal(started, true);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].body, "please collaborate");
  assert.equal(prompts[0].metadata.messageId, "message-42");
  assert.deepEqual(sent, [{ body: "reply to: please collaborate", sourceMessageId: "message-42" }]);
});


test("partial successful replies remain counted when a bridge step reports an error", async () => {
  let calls = 0;
  const runner = new OriginalSessionWakeRunner({
    bridge: { step: async () => {
      calls++;
      return { status: "error", sent: 1, processed: 2, message: "second message failed safely" };
    } },
    wakeSource: { waitForWake: async () => ({ status: "wake" }), close: async () => {} },
    maxReplies: 1,
    maxConsecutiveErrors: 3,
  });
  assert.deepEqual(await runner.run({ approved: true }), { status: "error", replies: 1 });
  assert.equal(calls, 1);
});
