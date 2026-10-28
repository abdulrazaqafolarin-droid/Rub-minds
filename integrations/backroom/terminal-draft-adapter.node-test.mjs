import test from "node:test";
import assert from "node:assert/strict";
import { TerminalDraftAdapter } from "./terminal-draft-adapter.mjs";

function fixture(options = {}) {
  let text = options.initial ?? "";
  let state = {
    connected: true, focused: true, editable: true, surface: "terminal",
    appId: "terminal.vscode", sessionId: "pty-session-7",
    identityFingerprint: "window:42:pty:7", locatorValue: "terminal/session/7", inputKind: "assistant_composer",
    ...options.state,
  };
  let writes = 0;
  let lastWrite = null;
  const driver = {
    inspect: async () => ({ ...state, text }),
    writeTextIfEmpty: async (request) => {
      lastWrite = request;
      if (options.onWrite) return options.onWrite({ request, getText: () => text, setText: value => { text = value; }, getState: () => state, setState: value => { state = { ...state, ...value }; } });
      if (state.sessionId !== request.sessionId ||
          state.identityFingerprint !== request.identityFingerprint ||
          state.inputKind !== request.expectedInputKind ||
          text !== request.expectedText) return { state: text !== "" ? "occupied" : "unavailable", submitted: false };
      writes++;
      text = request.text;
      if (options.corrupt) text = "unexpected terminal buffer";
      if (options.afterWriteState) state = { ...state, ...options.afterWriteState };
      return { state: options.writeState ?? (options.corrupt ? "unverified" : "written"),
        submitted: options.submitted ?? false };
    },
  };
  const adapter = new TerminalDraftAdapter({
    driver, appId: "terminal.vscode", sessionId: "pty-session-7",
    identityFingerprint: "window:42:pty:7", locatorValue: "terminal/session/7",
  });
  const target = {
    id: "terminal-target-1", roomId: "room-1", hostId: "host-1", spaceId: "space-1",
    surface: "terminal", locatorKind: "terminal_pty", locatorValue: "terminal/session/7",
    appId: "terminal.vscode", sessionId: "pty-session-7",
    identityFingerprint: "window:42:pty:7", revision: 1,
  };
  return { adapter, target, driver, text: () => text, writes: () => writes, lastWrite: () => lastWrite, state: () => state };
}

test("a named terminal session accepts a verified draft but never submits it", async () => {
  const f = fixture();
  assert.equal((await f.adapter.probe({ target: f.target, operation: "draft" })).connected, true);
  const result = await f.adapter.execute({ command: { operation: "draft", text: "Review this group task" }, target: f.target });
  assert.deepEqual(result, { state: "completed", verified: true, result: { drafted: true, submitted: false } });
  assert.equal(f.text(), "Review this group task");
  assert.equal(f.writes(), 1);
  assert.equal(f.lastWrite().submit, false);
  assert.equal(f.lastWrite().expectedText, "");
});

test("terminal input rejects line breaks and terminal control characters before writing", async () => {
  for (const text of ["first\nsecond", "command\r", "bell\u0007", "escape\u001b[31m", "nul\u0000"]) {
    const f = fixture();
    await assert.rejects(() => f.adapter.execute({ command: { operation: "draft", text }, target: f.target }), /single-line text/);
    assert.equal(f.writes(), 0);
    assert.equal(f.text(), "");
  }
});

test("terminal target must be a named terminal_pty target with matching identity", async () => {
  const f = fixture();
  assert.equal((await f.adapter.probe({ target: { ...f.target, locatorKind: "accessibility" }, operation: "draft" })).connected, false);
  assert.equal((await f.adapter.probe({ target: { ...f.target, surface: "windows_app" }, operation: "draft" })).connected, false);
  await assert.rejects(() => f.adapter.execute({ command: { operation: "draft", text: "draft" }, target: { ...f.target, sessionId: "other-pty" } }), /binding changed/);
  assert.equal(f.writes(), 0);
});

test("lost focus or changed PTY identity blocks a draft", async () => {
  for (const state of [{ focused: false }, { connected: false }, { editable: false }, { sessionId: "other-pty" }, { identityFingerprint: "window:99:pty:9" }, { locatorValue: "terminal/session/99" }]) {
    const f = fixture({ state });
    assert.equal((await f.adapter.probe({ target: f.target, operation: "draft" })).connected, false);
    await assert.rejects(() => f.adapter.execute({ command: { operation: "draft", text: "draft" }, target: f.target }), /identity changed/);
    assert.equal(f.writes(), 0);
  }
});

test("a raw shell prompt is not accepted as an AI assistant composer", async () => {
  const f = fixture({ state: { inputKind: "shell_prompt" } });
  assert.equal((await f.adapter.probe({ target: f.target, operation: "draft" })).connected, false);
  await assert.rejects(() => f.adapter.execute({ command: { operation: "draft", text: "rm -rf ~" }, target: f.target }), /input buffer or session identity changed/);
  assert.equal(f.writes(), 0);
  assert.equal(f.text(), "");
});

test("an already occupied terminal prompt is never overwritten", async () => {
  const f = fixture({ initial: "human typing" });
  await assert.rejects(() => f.adapter.execute({ command: { operation: "draft", text: "overwrite" }, target: f.target }), /occupied/);
  assert.equal(f.text(), "human typing");
  assert.equal(f.writes(), 0);
});

test("a human typing race is caught by the atomic write contract", async () => {
  const f = fixture({ onWrite: ({ setText }) => { setText("human raced"); return { state: "occupied", submitted: false }; } });
  await assert.rejects(() => f.adapter.execute({ command: { operation: "draft", text: "AI text" }, target: f.target }), /became occupied/);
  assert.equal(f.text(), "human raced");
  assert.equal(f.writes(), 0);
});

test("submit and read_result operations are rejected by the terminal draft adapter", async () => {
  const f = fixture();
  for (const operation of ["submit", "read_result"]) {
    await assert.rejects(() => f.adapter.execute({ command: { operation, text: "do not execute" }, target: f.target }), /draft-only/);
  }
  assert.equal(f.writes(), 0);
});

test("an unattested or ambiguous terminal write requests review, not retry", async () => {
  for (const options of [{ writeState: "unverified" }, { submitted: true }, { afterWriteState: { focused: false } }, { corrupt: true }]) {
    const f = fixture(options);
    const result = await f.adapter.execute({ command: { operation: "draft", text: "draft" }, target: f.target });
    assert.equal(result.state, "needs_review");
    assert.equal(result.verified, false);
  }
});

test("driver creation requires the atomic empty-checking write contract", () => {
  assert.throws(() => new TerminalDraftAdapter({ driver: { inspect() {} }, appId: "a", sessionId: "s", identityFingerprint: "i", locatorValue: "pty" }), /writeTextIfEmpty/);
});
