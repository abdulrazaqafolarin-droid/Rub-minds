/**
 * Draft-only adapter contract for an explicitly selected, inspectable terminal editor.
 *
 * This is not a generic shell executor and does not launch a PTY. A real host
 * driver must identify a named terminal session and explicitly distinguish an
 * `assistant_composer` from a raw shell prompt, then atomically recheck identity
 * plus the empty input buffer. Text containing control characters or line
 * separators is rejected so a draft cannot carry an Enter/newline command.
 */
const MAX_TERMINAL_DRAFT_CHARS = 4_000;
const REQUIRED_TERMINAL_INPUT_KIND = "assistant_composer";
const hasTerminalControls = text => {
  for (const character of text) {
    const code = character.codePointAt(0);
    if ((code >= 0 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 || code === 0x2029) return true;
  }
  return false;
};

export class TerminalDraftAdapter {
  constructor({ driver, appId, sessionId, identityFingerprint, locatorValue }) {
    if (!driver || typeof driver.inspect !== "function" || typeof driver.writeTextIfEmpty !== "function") {
      throw new TypeError("terminal driver must support inspect and writeTextIfEmpty");
    }
    if ([appId, sessionId, identityFingerprint, locatorValue].some(value =>
      typeof value !== "string" || !value.trim())) {
      throw new TypeError("terminal session binding required");
    }
    Object.assign(this, { driver, appId, sessionId, identityFingerprint, locatorValue });
  }

  async #current() {
    const state = await this.driver.inspect({ locator: this.locatorValue, expectedInputKind: REQUIRED_TERMINAL_INPUT_KIND });
    if (!state || state.connected !== true || state.focused !== true || state.editable !== true ||
      state.surface !== "terminal" || state.appId !== this.appId ||
      state.sessionId !== this.sessionId || state.identityFingerprint !== this.identityFingerprint ||
      state.locatorValue !== this.locatorValue || state.inputKind !== REQUIRED_TERMINAL_INPUT_KIND || typeof state.text !== "string") {
      throw new Error("terminal focus, input buffer or session identity changed");
    }
    return state;
  }

  async probe({ target, operation }) {
    if (operation !== "draft" || target?.surface !== "terminal" ||
      target.locatorKind !== "terminal_pty" || target.locatorValue !== this.locatorValue ||
      target.appId !== this.appId || target.sessionId !== this.sessionId ||
      target.identityFingerprint !== this.identityFingerprint) {
      return { connected: false, focused: false };
    }
    try {
      const state = await this.#current();
      if (state.text !== "") return { connected: false, focused: false };
      return {
        connected: true, focused: true, surface: "terminal", appId: this.appId,
        sessionId: this.sessionId, identityFingerprint: this.identityFingerprint,
        locatorKinds: ["terminal_pty"],
      };
    } catch {
      return { connected: false, focused: false };
    }
  }

  async execute({ command, target }) {
    if (!command || command.operation !== "draft" || target?.surface !== "terminal" ||
      target.locatorKind !== "terminal_pty" || target.locatorValue !== this.locatorValue ||
      target.appId !== this.appId || target.sessionId !== this.sessionId ||
      target.identityFingerprint !== this.identityFingerprint) {
      throw new Error("terminal binding changed or operation is not draft-only");
    }
    const text = command.text;
    if (typeof text !== "string" || !text.trim() || text.length > MAX_TERMINAL_DRAFT_CHARS ||
      hasTerminalControls(text)) {
      throw new TypeError("terminal drafts must be 1-4000 characters of single-line text without control characters");
    }

    const before = await this.#current();
    if (before.text !== "") {
      const error = new Error("cannot overwrite an occupied terminal input buffer");
      error.code = "BACKROOM_PREFLIGHT";
      throw error;
    }

    // The driver must recheck the same session and expected empty buffer inside
    // its atomic write. submit:false is a contract, not a request to press Enter.
    const write = await this.driver.writeTextIfEmpty({
      locator: this.locatorValue, text, appId: this.appId, sessionId: this.sessionId,
      identityFingerprint: this.identityFingerprint, expectedText: "", expectedInputKind: REQUIRED_TERMINAL_INPUT_KIND, submit: false,
    });
    if (!write || write.state === "occupied" || write.state === "unavailable") {
      const error = new Error(write?.state === "occupied"
        ? "terminal input became occupied before writing"
        : "terminal input is no longer available");
      error.code = "BACKROOM_PREFLIGHT";
      throw error;
    }

    // If a driver cannot attest that it did not submit, or readback is
    // ambiguous, never report success and never automatically retry.
    if (write.state !== "written" || write.submitted !== false) {
      return { state: "needs_review", verified: false, result: null };
    }
    const after = await this.#current().catch(() => null);
    if (!after || after.text !== text) {
      return { state: "needs_review", verified: false, result: null };
    }
    return { state: "completed", verified: true, result: { drafted: true, submitted: false } };
  }
}
