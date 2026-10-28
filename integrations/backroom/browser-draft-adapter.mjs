/**
 * Browser-only draft adapter for a user-supplied, already-authorized Playwright page.
 * No automatic submit, credential access or external browser creation.
 */
export class BrowserDraftAdapter {
  constructor({ page, origin, path, selector, appId, sessionId, identityFingerprint }) {
    if (!page || typeof page.url !== "function" || typeof page.locator !== "function") throw new TypeError("Playwright page required");
    if ([origin,path,selector,appId,sessionId,identityFingerprint].some(x=>typeof x!=="string"||!x)) throw new TypeError("binding incomplete");
    if (!["http:", "https:"].includes(new URL(origin).protocol) || new URL(origin).origin!==origin || !path.startsWith("/")) throw new TypeError("invalid URL binding");
    Object.assign(this, { page, origin, path, selector, appId, sessionId, identityFingerprint });
  }
  async #field() {
    if (this.page.isClosed()) throw new Error("page closed");
    const url = new URL(this.page.url());
    if (url.origin !== this.origin || url.pathname !== this.path) throw new Error("conversation changed");
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
    if (await this.#read(f) !== "") throw new Error("existing draft cannot be overwritten");
    await f.fill(command.text);
    if (await this.#read(f) !== command.text) return { state:"needs_review", verified:false };
    return { state:"completed", verified:true, result:{ drafted:true, submitted:false } };
  }
}
