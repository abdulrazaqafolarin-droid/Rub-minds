import test from "node:test";
import assert from "node:assert/strict";
import { TargetRegistry } from "./target-registry.mjs";
import { BackroomDispatcher } from "./dispatcher.mjs";
import { LocalExecutionGuard } from "./host-runtime.mjs";
import { TerminalDraftAdapter } from "./terminal-draft-adapter.mjs";

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
  assert.equal((await dispatcher.step(command.id, { approved: true })).state, "failed");
  assert.equal(writes(), 0);
});
test("offline, denied or unfocused native app cannot receive the draft", async () => {
  for (const settings of [{ online: false }, { allowed: false }, { focused: false }]) {
    const { dispatcher, writes } = createSystem(settings);
    dispatcher.enqueue(command);
    assert.equal((await dispatcher.step(command.id, { approved: true })).state, "failed");
    assert.equal(writes(), 0);
  }
});

test("group event -> named terminal session -> explicitly approved draft, never submit", async () => {
  const target = {
    id: "terminal-target", roomId: "group-9", hostId: "desktop-1", spaceId: "terminal-space",
    sessionId: "pty-27", appId: "terminal.frontend", identityFingerprint: "window-8:pty-27",
    locatorKind: "terminal_pty", locatorValue: "terminal/session/27", surface: "terminal", revision: 1,
  };
  const command = {
    id: "terminal-task", eventId: "message-900", roomId: "group-9", hostId: "desktop-1",
    spaceId: "terminal-space", sessionId: "pty-27", identityFingerprint: "window-8:pty-27",
    targetId: target.id, targetRevision: 1, text: "@RMConnects: review the task", operation: "draft",
  };
  let buffer = "";
  let writes = 0;
  let submits = 0;
  const driver = {
    inspect: async () => ({
      connected: true, focused: true, editable: true, surface: "terminal", inputKind: "assistant_composer",
      appId: target.appId, sessionId: target.sessionId,
      identityFingerprint: target.identityFingerprint, locatorValue: target.locatorValue, text: buffer,
    }),
    writeTextIfEmpty: async request => {
      if (request.submit !== false) submits++;
      if (request.appId !== target.appId || request.sessionId !== target.sessionId ||
          request.identityFingerprint !== target.identityFingerprint || request.expectedInputKind !== "assistant_composer" ||
          request.expectedText !== "" || buffer !== "") {
        return { state: buffer ? "occupied" : "unavailable", submitted: false };
      }
      writes++;
      buffer = request.text;
      return { state: "written", submitted: false };
    },
  };
  const adapter = new TerminalDraftAdapter({
    driver, appId: target.appId, sessionId: target.sessionId,
    identityFingerprint: target.identityFingerprint, locatorValue: target.locatorValue,
  });
  const registry = new TargetRegistry();
  registry.register(target);
  const guard = new LocalExecutionGuard({
    host: { hostId: target.hostId, deviceLabel: "Named terminal session", surfaces: ["terminal"], operations: ["draft"] },
    adapter, permission: async () => true, isConnected: async () => true,
  });
  const dispatcher = new BackroomDispatcher({ registry, adapter: guard, authorize: async () => true });
  dispatcher.enqueue(command);
  assert.equal((await dispatcher.step(command.id)).state, "awaiting_approval");
  assert.equal((await dispatcher.step(command.id, { approved: true })).state, "completed");
  assert.equal(buffer, command.text);
  assert.equal(writes, 1);
  assert.equal(submits, 0);
});
