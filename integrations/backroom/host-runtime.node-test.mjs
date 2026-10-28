import test from "node:test";
import assert from "node:assert/strict";
import { LocalExecutionGuard, validateHostCapabilities } from "./host-runtime.mjs";
const host = { hostId: "h", deviceLabel: "Local host", surfaces: ["android_app"], operations: ["draft"] };
const target = { id: "t", hostId: "h", roomId: "r", spaceId: "s", sessionId: "session", appId: "ai.app", surface: "android_app", locatorKind: "accessibility", identityFingerprint: "fingerprint", revision: 1 };
const command = { hostId: "h", targetId: "t", roomId: "r", spaceId: "s", sessionId: "session", targetRevision: 1, operation: "draft", text: "test" };
const probe = { focused: true, connected: true, sessionId: "session", appId: "ai.app", surface: "android_app", locatorKinds: ["accessibility"], identityFingerprint: "fingerprint" };
function configured(overrides = {}) {
  let calls = 0;
  const guard = new LocalExecutionGuard({
    host, isConnected: async () => true, permission: async () => true,
    adapter: { probe: async () => ({ ...probe, ...(overrides.probe || {}) }), execute: async () => {
      calls++;
      return overrides.outcome || { state: "completed", verified: true, result: "typed" };
    } }, ...overrides.runtime,
  });
  return { guard, calls: () => calls };
}
test("host capabilities are strict and immutable", () => {
  assert.deepEqual(validateHostCapabilities(host).surfaces, ["android_app"]);
  assert.throws(() => validateHostCapabilities({ ...host, surfaces: ["android_app", "android_app"] }), /duplicate/);
  assert.throws(() => validateHostCapabilities({ ...host, operations: ["shell"] }), /invalid/);
});
test("authorized native app target produces verified result", async () => {
  const { guard, calls } = configured();
  const result = await guard.execute({ command, target });
  assert.equal(result.state, "completed");
  assert.equal(calls(), 1);
});
test("changed focus and identity block the action before typing", async () => {
  for (const changed of [{ focused: false }, { connected: false }, { appId: "other" },
    { sessionId: "other" }, { identityFingerprint: "old" }, { locatorKinds: [] }]) {
    const { guard, calls } = configured({ probe: changed });
    await assert.rejects(() => guard.execute({ command, target }), /mismatch/);
    assert.equal(calls(), 0);
  }
});
test("host offline or permission denied block all side effects", async () => {
  for (const runtime of [{ isConnected: async () => false }, { permission: async () => false }]) {
    const { guard, calls } = configured({ runtime });
    await assert.rejects(() => guard.execute({ command, target }), /offline|denied/);
    assert.equal(calls(), 0);
  }
});
test("unverified outcome requires human review", async () => {
  const { guard } = configured({ outcome: { state: "completed", verified: false } });
  assert.equal((await guard.execute({ command, target })).state, "needs_review");
});
test("wrong group, host and capability fail closed", async () => {
  const { guard } = configured();
  await assert.rejects(() => guard.execute({ command: { ...command, roomId: "wrong" }, target }), /scope/);
  await assert.rejects(() => guard.execute({ command: { ...command, operation: "submit" }, target }), /capability/);
});
