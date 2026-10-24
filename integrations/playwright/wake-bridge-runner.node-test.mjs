import test from "node:test";
import assert from "node:assert/strict";
import { OriginalSessionWakeRunner } from "./wake-bridge-runner.mjs";

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
    bridge: { step: async ({ approved, remainingReplies }) => {
      assert.equal(approved, true);
      assert.equal(remainingReplies, 2 - steps);
      steps++;
      return { status: "ok", sent: 1 };
    } },
    wakeSource: { waitForWake: async () => ({ status: ++waits <= 2 ? "wake" : "closed" }) },
    maxReplies: 2,
  });
  assert.deepEqual(await runner.run({ approved: true }), { status: "finished", replies: 2 });
  assert.equal(steps, 2);
});

test("heartbeat timeout still checks durable messages to recover missed notifications", async () => {
  let wakeCount = 0;
  let stepCount = 0;
  const runner = new OriginalSessionWakeRunner({
    bridge: { step: async () => { stepCount++; return { status: "ok", sent: 0 }; } },
    wakeSource: { waitForWake: async () => ({ status: ++wakeCount === 1 ? "timeout" : "closed" }) },
    heartbeatMs: 1000,
  });
  assert.deepEqual(await runner.run({ approved: true }), { status: "finished", replies: 0 });
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
  assert.deepEqual(await result, { status: "finished", replies: 0 });
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
  assert.equal(statuses.filter(status => status === "error").length, 2);
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
  assert.deepEqual(await result, { status: "finished", replies: 0 });
});
