import test from "node:test";
import assert from "node:assert/strict";
import { TargetRegistry } from "./target-registry.mjs";
import { BackroomDispatcher } from "./dispatcher.mjs";
import { LocalExecutionGuard } from "./host-runtime.mjs";

const target = {
  id: "composer", roomId: "group-1", hostId: "phone-1", spaceId: "claude-native",
  sessionId: "conversation-4", appId: "ai.native.app",
  identityFingerprint: "app-window-4", locatorKind: "accessibility",
  locatorValue: "message_editor", surface: "android_app", revision: 1,
};
const command = {
  id: "task-1", eventId: "group-message-71", roomId: "group-1",
  hostId: "phone-1", spaceId: "claude-native", sessionId: "conversation-4",
  identityFingerprint: "app-window-4", targetId: "composer",
  targetRevision: 1, text: "@RMConnects: Review the group's latest question",
  operation: "draft",
};
function createSystem(overrides = {}) {
  const registry = new TargetRegistry();
  registry.register(target);
  let writes = 0;
  const guard = new LocalExecutionGuard({
    host: { hostId: "phone-1", deviceLabel: "Android test host",
      surfaces: ["android_app"], operations: ["draft"] },
    permission: async () => overrides.allowed !== false,
    isConnected: async () => overrides.online !== false,
    adapter: {
      probe: async () => ({ connected: true, focused: overrides.focused !== false,
        sessionId: "conversation-4", appId: overrides.appId || "ai.native.app",
        surface: "android_app", locatorKinds: ["accessibility"],
        identityFingerprint: "app-window-4" }),
      execute: async () => { writes++; return { state: "completed", verified: true, result: { inserted: true } }; },
    },
  });
  const dispatcher = new BackroomDispatcher({
    registry, adapter: guard, authorize: async () => true,
  });
  return { dispatcher, writes: () => writes };
}
test("group event -> native app identity check -> permitted draft -> deduplicated result", async () => {
  const { dispatcher, writes } = createSystem();
  dispatcher.enqueue(command);
  assert.equal((await dispatcher.step(command.id)).state, "awaiting_approval");
  assert.equal((await dispatcher.step(command.id, { approved: true })).state, "completed");
  assert.equal(writes(), 1);
  assert.equal(dispatcher.enqueue({ ...command, id: "duplicate" }).state, "completed");
  assert.equal(writes(), 1);
});
test("wrong app foreground cannot receive the group draft", async () => {
  const { dispatcher, writes } = createSystem({ appId: "other.native.app" });
  dispatcher.enqueue(command);
  assert.equal((await dispatcher.step(command.id, { approved: true })).state, "needs_review");
  assert.equal(writes(), 0);
});
test("offline, denied or unfocused native app cannot receive the draft", async () => {
  for (const settings of [{ online: false }, { allowed: false }, { focused: false }]) {
    const { dispatcher, writes } = createSystem(settings);
    dispatcher.enqueue(command);
    assert.equal((await dispatcher.step(command.id, { approved: true })).state, "needs_review");
    assert.equal(writes(), 0);
  }
});
