import test from "node:test";
import assert from "node:assert/strict";
import { HybridSessionCoordinator } from "./hybrid-session-coordinator.mjs";

test("requires explicit approval", async () => {
  const coordinator = new HybridSessionCoordinator({});
  await assert.rejects(() => coordinator.start(), /Explicit user approval/);
  await assert.rejects(() => coordinator.step(), /Explicit user approval/);
});

test("prefers original session and never creates fallback when original is ready", async () => {
  let fallbackCreated = false;
  const original = { ready: async () => true, step: async () => ({ status: "ok", sent: 1 }) };
  const coordinator = new HybridSessionCoordinator({
    originalSession: original,
    independentSessionFactory: async () => { fallbackCreated = true; return {}; },
  });
  assert.deepEqual(await coordinator.start({ approved: true, allowIndependentFallback: true }), { mode: "original", status: "ready" });
  assert.equal(fallbackCreated, false);
  assert.deepEqual(await coordinator.step({ approved: true }), { mode: "original", status: "ok", sent: 1, totalReplies: 1 });
  await coordinator.stop();
  assert.equal(coordinator.mode, "stopped");
});

test("waits for original if fallback was not approved", async () => {
  const coordinator = new HybridSessionCoordinator({ originalSession: { ready: async () => false, step: async () => ({ status: "should_not_run" }) } });
  assert.deepEqual(await coordinator.start({ approved: true }), { mode: "waiting_for_original", status: "waiting_for_original" });
  assert.deepEqual(await coordinator.step({ approved: true }), { mode: "waiting_for_original", status: "not_connected" });
});

test("fallback is created only when explicitly enabled and is separate", async () => {
  let received;
  const independent = { ready: async () => true, step: async () => ({ status: "ok", sent: 1 }), close: async () => {} };
  const coordinator = new HybridSessionCoordinator({
    originalSession: { ready: async () => false, step: async () => ({ status: "should_not_run" }) },
    independentSessionFactory: async (args) => { received = args; return independent; },
  });
  assert.deepEqual(await coordinator.start({ approved: true, allowIndependentFallback: true, contextBrief: "approved summary" }), { mode: "independent", status: "ready" });
  assert.deepEqual(received, { contextBrief: "approved summary" });
  assert.deepEqual(await coordinator.step({ approved: true }), { mode: "independent", status: "ok", sent: 1, totalReplies: 1 });
  await coordinator.stop();
});

test("enforces reply cap", async () => {
  const coordinator = new HybridSessionCoordinator({
    originalSession: { ready: async () => true, step: async ({ remainingReplies }) => ({ sent: Math.min(2, remainingReplies) }) },
    maxReplies: 1,
  });
  await coordinator.start({ approved: true });
  assert.deepEqual(await coordinator.step({ approved: true }), { mode: "original", sent: 1, totalReplies: 1 });
  assert.deepEqual(await coordinator.step({ approved: true }), { mode: "original", status: "limit_reached" });
});
