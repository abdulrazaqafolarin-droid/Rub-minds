/**
 * Browser-only draft adapter for a user-supplied, already-authorized Playwright page.
 * No automatic submit, credential access or external browser creation.
 */
export class BrowserDraftAdapter {
  constructor({ page, origin, path, search = "", hash = "", selector, appId, sessionId, identityFingerprint }) {
    if (!page || typeof page.url !== "function" || typeof page.locator !== "function") throw new TypeError("Playwright page required");
    if ([origin,path,selector,appId,sessionId,identityFingerprint].some(x=>typeof x!=="string"||!x)) throw new TypeError("binding incomplete");
    if (!["http:", "https:"].includes(new URL(origin).protocol) || new URL(origin).origin!==origin || !path.startsWith("/")) throw new TypeError("invalid URL binding");
    Object.assign(this, { page, origin, path, search, hash, selector, appId, sessionId, identityFingerprint });
  }
  async #field() {
    if (this.page.isClosed()) throw new Error("page closed");
    const url = new URL(this.page.url());
    if (url.origin !== this.origin || url.pathname !== this.path || url.search !== this.search || url.hash !== this.hash) throw new Error("conversation changed");
    const field = this.page.locator(this.selector);
    if (await field.count() !== 1 || !(await field.isVisible()) || !(await field.isEnabled())) throw new Error("composer unavailable");
    return field;
  }
  async #read(field) {
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
    const insertion = await f.evaluate((element, text) => {
      if (!(element instanceof HTMLElement) || !element.isConnected ||
        ("disabled" in element && element.disabled) || ("readOnly" in element && element.readOnly) ||
        element.getAttribute("aria-disabled") === "true" || element.getAttribute("aria-readonly") === "true") {
        return { state: "unavailable" };
      }
      const readValue = () => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.value
        : element.isContentEditable ? element.textContent ?? "" : null;
      if (readValue() === null) return { state: "unavailable" };
      if (readValue() !== "") return { state: "occupied" };
      element.focus({ preventScroll: true });
      if (element instanceof HTMLInputElement) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, text);
      } else if (element instanceof HTMLTextAreaElement) {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(element, text);
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
        if (!document.execCommand("insertText", false, text)) return { state: "unavailable" };
      } else {
        return { state: "unavailable" };
      }
      if (!(element instanceof HTMLElement) || !element.isConnected) return { state: "unverified" };
      if (!element.isContentEditable) {
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return { state: readValue() === text ? "inserted" : "unverified" };
    }, command.text);
    if (insertion.state === "occupied" || insertion.state === "unavailable") {
      const error = new Error(insertion.state === "occupied"
        ? "existing draft cannot be overwritten"
        : "composer is no longer editable");
      error.code = "BACKROOM_PREFLIGHT";
      throw error;
    }
    if (insertion.state !== "inserted") return { state:"needs_review", verified:false };
    if (await this.#read(f) !== command.text) return { state:"needs_review", verified:false };
    return { state:"completed", verified:true, result:{ drafted:true, submitted:false } };
  }
}
