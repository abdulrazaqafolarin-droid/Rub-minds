import test from "node:test";
import assert from "node:assert/strict";
import { BackroomDispatcher } from "./dispatcher.mjs";
import { TargetRegistry } from "./target-registry.mjs";

function setup(execute = async () => ({ state: "completed", result: "ok" }), authorize = async () => true) {
  const registry = new TargetRegistry();
  registry.register({ id: "target", roomId: "room", hostId: "host", spaceId: "space",
    sessionId: "session", appId: "example", identityFingerprint: "window:42",
    surface: "desktop_app", locatorKind: "accessibility", locatorValue: "prompt", revision: 1 });
  const dispatcher = new BackroomDispatcher({ registry, adapter: { execute }, authorize });
  const command = { id: "job", eventId: "event", roomId: "room", hostId: "host",
    spaceId: "space", sessionId: "session", identityFingerprint: "window:42",
    targetId: "target", targetRevision: 1, operation: "draft", text: "review this" };
  return { dispatcher, registry, command };
}
test("approval gate prevents execution until approved", async () => {
  let calls = 0;
  const { dispatcher, command } = setup(async () => { calls++; return { state: "completed" }; });
  dispatcher.enqueue(command);
  assert.equal((await dispatcher.step("job")).state, "awaiting_approval");
  assert.equal(calls, 0);
  assert.equal((await dispatcher.step("job", { approved: true })).state, "completed");
  assert.equal(calls, 1);
  assert.equal((await dispatcher.step("job", { approved: true })).state, "completed");
  assert.equal(calls, 1);
});
test("event dedupe and command id conflict", () => {
  const { dispatcher, command } = setup();
  dispatcher.enqueue(command);
  assert.equal(dispatcher.enqueue({ ...command, id: "job2" }).id, "job");
  assert.throws(() => dispatcher.enqueue({ ...command, text: "changed" }), /conflict/);
});
test("deny and wrong target identity fail closed", async () => {
  const denied = setup(undefined, async () => false);
  denied.dispatcher.enqueue(denied.command);
  assert.equal((await denied.dispatcher.step("job", { approved: true })).reason, "not_authorized");
  const wrong = setup();
  wrong.dispatcher.enqueue({ ...wrong.command, identityFingerprint: "different" });
  assert.equal((await wrong.dispatcher.step("job", { approved: true })).reason, "stale_or_wrong_target");
});
test("ambiguous adapter effects require review", async () => {
  let calls = 0;
  const { dispatcher, command } = setup(async () => { calls++; throw new Error("unknown result"); });
  dispatcher.enqueue(command);
  assert.equal((await dispatcher.step("job", { approved: true })).state, "needs_review");
  assert.equal((await dispatcher.step("job", { approved: true })).state, "needs_review");
  assert.equal(calls, 1);
});
test("cancel prevents pending job execution", async () => {
  const { dispatcher, command } = setup();
  dispatcher.enqueue(command);
  assert.equal(dispatcher.cancel("job"), true);
  assert.equal((await dispatcher.step("job", { approved: true })).state, "cancelled");
});
test("parallel steps execute at most once", async () => {
  let calls = 0;
  const { dispatcher, command } = setup(async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return { state: "completed" };
  }, async () => { await new Promise(resolve => setTimeout(resolve, 5)); return true; });
  dispatcher.enqueue(command);
  await Promise.all([dispatcher.step("job", { approved: true }), dispatcher.step("job", { approved: true })]);
  assert.equal(calls, 1);
});

test("cancel during authorization prevents action", async () => {
  let release = () => {};
  let calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const { dispatcher, command } = setup(async () => { calls++; return { state: "completed" }; }, async () => { await gate; return true; });
  dispatcher.enqueue(command);
  const pending = dispatcher.step("job", { approved: true });
  assert.equal(dispatcher.cancel("job"), true);
  release();
  assert.equal((await pending).state, "cancelled");
  assert.equal(calls, 0);
});
