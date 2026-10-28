/**
 * Browser-only draft adapter for a user-supplied, already-authorized Playwright page.
 * No automatic submit, credential access or external browser creation.
 */
export class BrowserDraftAdapter {
  constructor({ page, origin, path, search = "", hash = "", selector, appId, sessionId, identityFingerprint, nodeHandle = null }) {
    if (!page || typeof page.url !== "function" || typeof page.locator !== "function") throw new TypeError("Playwright page required");
    if ([origin,path,selector,appId,sessionId,identityFingerprint].some(x=>typeof x!=="string"||!x)) throw new TypeError("binding incomplete");
    if (!["http:", "https:"].includes(new URL(origin).protocol) || new URL(origin).origin!==origin || !path.startsWith("/")) throw new TypeError("invalid URL binding");
    if (nodeHandle !== null && (!nodeHandle || typeof nodeHandle.evaluate !== "function")) throw new TypeError("exact DOM element handle required");
    Object.assign(this, { page, origin, path, search, hash, selector, appId, sessionId, identityFingerprint, nodeHandle });
  }
  async #field() {
    if (this.page.isClosed()) throw new Error("page closed");
    const url = new URL(this.page.url());
    if (url.origin !== this.origin || url.pathname !== this.path || url.search !== this.search || url.hash !== this.hash) throw new Error("conversation changed");
    const field = this.page.locator(this.selector);
    if (await field.count() !== 1 || !(await field.isVisible()) || !(await field.isEnabled())) throw new Error("composer unavailable");
    if (this.nodeHandle) {
      const isExactNode = await this.nodeHandle.evaluate((node, selector) => {
        if (!(node instanceof HTMLElement) || !node.isConnected || !node.matches(selector)) return false;
        try {
          const matches = document.querySelectorAll(selector);
          return matches.length === 1 && matches[0] === node;
        } catch { return false; }
      }, this.selector).catch(() => false);
      if (!isExactNode) throw new Error("composer replaced after target registration");
    }
    return field;
  }
  async #read(field) {
    if (this.nodeHandle) {
      return this.nodeHandle.evaluate(element => {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value;
        return element instanceof HTMLElement && element.isContentEditable ? element.textContent ?? "" : null;
      });
    }
    try { return await field.inputValue(); }
    catch { return await field.textContent(); }
  }
  async probe({ target, operation }) {
    if (operation!=="draft" || target?.surface!=="browser_tab" || target.locatorKind!=="dom" || target.locatorValue!==this.selector) return { focused:false, connected:false };
    try {
      const f = await this.#field();
      if (await this.#read(f) !== "") return { focused:false, connected:false };
      return { focused:true, connected:true, appId:this.appId, sessionId:this.sessionId, identityFingerprint:this.identityFingerprint, surface:"browser_tab", locatorKinds:["dom"] };
    } catch { return { focused:false, connected:false }; }
  }
  async execute({ command, target }) {
    if (command.operation!=="draft" || target.locatorValue!==this.selector || target.appId!==this.appId || target.sessionId!==this.sessionId || target.identityFingerprint!==this.identityFingerprint) throw new Error("binding changed");
    const f = await this.#field();
    // Check and insert in one synchronous page task. A separate value read then
    // locator.fill() could overwrite a human draft typed between the two actions.
    const bindingMarker = /\[data-rm-backroom-binding="([a-f0-9-]{36})"\]$/i.exec(this.selector)?.[1] ?? null;
    const insertionRequest = {
      text: command.text, origin: this.origin, path: this.path, search: this.search, hash: this.hash,
      selector: this.selector, bindingMarker,
    };
    // URL and DOM identity must be rechecked in the same synchronous page task
    // that writes. Checking them only in #field() leaves a navigation/rerender
    // window between preflight and insertion.
    const performInsertion = (element, request) => {
      const identityState = () => {
        const current = window.location;
        if (current.origin !== request.origin || current.pathname !== request.path ||
          current.search !== request.search || current.hash !== request.hash) return "conversation_changed";
        if (!(element instanceof HTMLElement) || !element.isConnected ||
          !element.matches(request.selector) ||
          (request.bindingMarker && element.getAttribute("data-rm-backroom-binding") !== request.bindingMarker)) {
          return "unavailable";
        }
        try {
          const matches = document.querySelectorAll(request.selector);
          if (matches.length !== 1 || matches[0] !== element) return "unavailable";
        } catch { return "unavailable"; }
        return "valid";
      };
      const initialIdentity = identityState();
      if (initialIdentity !== "valid") return { state: initialIdentity };
      if (("disabled" in element && element.disabled) || ("readOnly" in element && element.readOnly) ||
        element.getAttribute("aria-disabled") === "true" || element.getAttribute("aria-readonly") === "true") {
        return { state: "unavailable" };
      }
      const readValue = () => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.value
        : element.isContentEditable ? element.textContent ?? "" : null;
      if (readValue() === null) return { state: "unavailable" };
      if (readValue() !== "") return { state: "occupied" };
      element.focus({ preventScroll: true });
      // Focus handlers can reroute a SPA, replace the composer, or populate it.
      // Recheck all of those conditions before touching its value.
      const postFocusIdentity = identityState();
      if (postFocusIdentity !== "valid") return { state: postFocusIdentity };
      if (readValue() === null) return { state: "unavailable" };
      if (readValue() !== "") return { state: "occupied" };
      if (element instanceof HTMLInputElement) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, request.text);
      } else if (element instanceof HTMLTextAreaElement) {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(element, request.text);
      } else if (element.isContentEditable) {
        // execCommand runs the browser's editing pipeline synchronously and emits
        // an input event; directly setting textContent often leaves rich-editor
        // application state (e.g. React/ProseMirror/Lexical) out of sync.
        const selection = window.getSelection();
        if (!selection) return { state: "unavailable" };
        const range = document.createRange();
        range.selectNodeContents(element);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
        if (!document.execCommand("insertText", false, request.text)) return { state: "unavailable" };
      } else {
        return { state: "unavailable" };
      }
      if (!(element instanceof HTMLElement) || !element.isConnected) return { state: "unverified" };
      if (!element.isContentEditable) {
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: request.text }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return { state: readValue() === request.text ? "inserted" : "unverified" };
    };
    // When a target came from the interactive selection overlay, write through
    // the retained ElementHandle itself, not a locator that could resolve to a
    // replacement composer while the SPA is rerendering.
    const insertion = this.nodeHandle
      ? await this.nodeHandle.evaluate(performInsertion, insertionRequest)
      : await f.evaluate(performInsertion, insertionRequest);
    if (insertion.state === "conversation_changed") {
      const error = new Error("conversation changed immediately before or during draft insertion");
      error.code = "BACKROOM_PREFLIGHT";
      throw error;
    }
    if (insertion.state === "occupied" || insertion.state === "unavailable") {
      const error = new Error(insertion.state === "occupied"
        ? "existing draft cannot be overwritten"
        : "composer is no longer editable");
      error.code = "BACKROOM_PREFLIGHT";
      throw error;
    }
    if (insertion.state !== "inserted") return { state:"needs_review", verified:false };
    if (this.nodeHandle) {
      const finalState = await this.nodeHandle.evaluate((element, expected) => {
        const current = window.location;
        const correctConversation = current.origin === expected.origin && current.pathname === expected.path &&
          current.search === expected.search && current.hash === expected.hash;
        const correctNode = element instanceof HTMLElement && element.isConnected && element.matches(expected.selector) &&
          (!expected.bindingMarker || element.getAttribute("data-rm-backroom-binding") === expected.bindingMarker);
        let uniqueNode = false;
        try {
          const matches = document.querySelectorAll(expected.selector);
          uniqueNode = matches.length === 1 && matches[0] === element;
        } catch {}
        return {
          connected: correctConversation && correctNode && uniqueNode,
          value: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
            ? element.value
            : element instanceof HTMLElement && element.isContentEditable ? element.textContent ?? "" : null,
        };
      }, insertionRequest);
      if (!finalState.connected || finalState.value !== command.text) return { state:"needs_review", verified:false };
    } else if (await this.#read(f) !== command.text) {
      return { state:"needs_review", verified:false };
    }
    return { state:"completed", verified:true, result:{ drafted:true, submitted:false } };
  }
}
