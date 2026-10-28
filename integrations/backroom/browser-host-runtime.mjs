import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { TargetRegistry } from "./target-registry.mjs";
import { BackroomDispatcher } from "./dispatcher.mjs";
import { LocalExecutionGuard } from "./host-runtime.mjs";
import { BrowserDraftAdapter } from "./browser-draft-adapter.mjs";

const safeSiteUrl = value => {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || (url.protocol === "http:" && ["localhost","127.0.0.1"].includes(url.hostname))) return url;
  } catch {}
  return null;
};
export function installSelectionOverlay() {
const isEditable = node => {
  if (!(node instanceof HTMLElement) || !node.isConnected) return false;
  if (node.closest('[aria-hidden="true"],[inert]')) return false;
  if ("disabled" in node && node.disabled) return false;
  if ("readOnly" in node && node.readOnly) return false;
  if (node.getAttribute("aria-disabled") === "true" || node.getAttribute("aria-readonly") === "true") return false;
  if (node instanceof HTMLInputElement && ["password","hidden","button","checkbox","radio","submit","reset","file","image","range","color"].includes(node.type)) return false;
  // A role=textbox is not necessarily writable; only native fields and truly
  // contenteditable nodes are eligible for registration.
  if (!(node instanceof HTMLInputElement) && !(node instanceof HTMLTextAreaElement) && !node.isContentEditable) return false;
  const box = node.getBoundingClientRect();
  const style = getComputedStyle(node);
  return box.width > 8 && box.height > 8 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
};
  const KEY = "__RM_BACKROOM_SELECTION_V1__";
  const OVERLAY_ID = "__rm_backroom_target_overlay_v1";
  document.getElementById(OVERLAY_ID)?.remove();
  window[KEY] = { state: "pending" };
  const root = document.createElement("div");
  root.id = OVERLAY_ID;
  root.style.cssText = "position:fixed;inset:0;z-index:2147483647;cursor:crosshair;touch-action:none;background:rgba(8,12,25,.15);";
  const hint = document.createElement("div");
  hint.textContent = "Backroom: drag around exactly one text input · Esc cancels";
  hint.style.cssText = "position:absolute;top:12px;left:50%;transform:translateX(-50%);max-width:90vw;background:#111827;color:#f4f4ff;border:1px solid #8b7cf6;border-radius:10px;padding:10px 14px;font:13px system-ui,sans-serif;box-shadow:0 5px 25px #0008;pointer-events:none;white-space:nowrap;";
  const rectangle = document.createElement("div");
  rectangle.style.cssText = "position:fixed;display:none;border:2px solid #a99aff;background:rgba(137,115,255,.22);pointer-events:none;box-sizing:border-box;";
  root.append(hint, rectangle);
  document.documentElement.append(root);
  let start = null;
  let finished = false;
  const endState = state => { window[KEY] = state; root.remove(); window.removeEventListener("keydown", onKey, true); };
  const onKey = event => {
    if (event.key === "Escape" && !finished) {
      finished = true;
      endState({ state: "cancelled" });
    }
  };
  const attrSelector = (node, attr) => {
    const value = node.getAttribute(attr);
    if (!value || value.length > 160 || /[\r\n]/.test(value)) return null;
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const selector = node.tagName.toLowerCase() + "[" + attr + '="' + escaped + '"]';
    try { return document.querySelectorAll(selector).length === 1 ? selector : null; } catch { return null; }
  };
  const uniqueSelector = node => {
    for (const attr of ["data-testid","data-test","aria-label","name","placeholder"]) {
      const selector = attrSelector(node, attr);
      if (selector) return selector;
    }
    if (node.id) {
      const selector = "#" + CSS.escape(node.id);
      try { if (document.querySelectorAll(selector).length === 1) return selector; } catch {}
    }
    const chain = [];
    let current = node;
    while (current && current.nodeType === 1 && current !== document.documentElement) {
      const tag = current.tagName.toLowerCase();
      let index = 1;
      let sibling = current.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === current.tagName) index++;
        sibling = sibling.previousElementSibling;
      }
      chain.unshift(tag + ":nth-of-type(" + index + ")");
      const selector = chain.join(" > ");
      try { if (document.querySelectorAll(selector).length === 1) return selector; } catch {}
      current = current.parentElement;
    }
    return null;
  };
  const fail = message => {
    finished = true;
    window[KEY] = { state: "failed", message };
    hint.textContent = message;
    hint.style.background = "#541d2b";
    window.setTimeout(() => endState(window[KEY]), 1200);
  };
  root.addEventListener("pointerdown", event => {
    if (finished || event.button !== 0) return;
    event.preventDefault();
    start = { x: event.clientX, y: event.clientY };
    root.setPointerCapture(event.pointerId);
    rectangle.style.display = "block";
    rectangle.style.left = start.x + "px";
    rectangle.style.top = start.y + "px";
    rectangle.style.width = "0px";
    rectangle.style.height = "0px";
  });
  root.addEventListener("pointermove", event => {
    if (!start || finished) return;
    event.preventDefault();
    const left = Math.min(start.x, event.clientX);
    const top = Math.min(start.y, event.clientY);
    rectangle.style.left = left + "px";
    rectangle.style.top = top + "px";
    rectangle.style.width = Math.abs(event.clientX - start.x) + "px";
    rectangle.style.height = Math.abs(event.clientY - start.y) + "px";
  });
  root.addEventListener("pointerup", event => {
    if (!start || finished) return;
    event.preventDefault();
    const end = { x: event.clientX, y: event.clientY };
    const bounds = {
      left: Math.min(start.x, end.x), top: Math.min(start.y, end.y),
      right: Math.max(start.x, end.x), bottom: Math.max(start.y, end.y),
    };
    start = null;
    root.style.display = "none";
    const candidates = [...document.querySelectorAll('textarea,input:not([type="password"]),[contenteditable="true"],[role="textbox"]')]
      .filter(node => isEditable(node))
      .filter(node => {
        const b = node.getBoundingClientRect();
        return b.left >= bounds.left && b.top >= bounds.top &&
          b.right <= bounds.right && b.bottom <= bounds.bottom;
      });
    if (bounds.right - bounds.left < 8 || bounds.bottom - bounds.top < 8) {
      fail("Selection too small. Drag around the full input.");
      return;
    }
    if (candidates.length !== 1) {
      fail(candidates.length ? "Select only one input area." : "No editable input fully inside selection.");
      return;
    }
    const node = candidates[0];
    const selector = uniqueSelector(node);
    if (!selector) { fail("Could not create a stable input selector. Try another area."); return; }
    finished = true;
    window[KEY] = {
      state: "selected", selector, tagName: node.tagName.toLowerCase(),
      role: node.getAttribute("role") || "", ariaLabel: node.getAttribute("aria-label") || "",
      selectedAt: Date.now(),
    };
    hint.textContent = "Input selected. Return to Rub Minds Backroom.";
    hint.style.background = "#153a32";
    window.setTimeout(() => root.remove(), 800);
    window.removeEventListener("keydown", onKey, true);
  });
  window.addEventListener("keydown", onKey, true);
  return { state: "pending" };
}

export class BrowserHostRuntime {
  #context = null;
  #starting = null;
  #pages = new Map();
  #pageIds = new WeakMap();
  #targets = new Map();
  #bindings = new Map();
  #selectionRooms = new Map();
  #browserModule = null;
  constructor({ hostId, profileDir = join(homedir(), ".rub-minds", "backroom", "browser-profile"),
    chromiumProvider = async () => (await import("playwright")).chromium } = {}) {
    if (typeof hostId !== "string" || !hostId) throw new TypeError("hostId required");
    this.hostId = hostId;
    this.profileDir = profileDir;
    this.registry = new TargetRegistry();
    this.dispatcher = new BackroomDispatcher({
      registry: this.registry,
      adapter: { execute: async ({ command, target }) => {
        const binding = this.#bindings.get(target.id);
        if (!binding) throw Object.assign(new Error("Target unavailable"), { code: "BACKROOM_PREFLIGHT" });
        return binding.guard.execute({ command, target });
      }},
      authorize: async () => true,
    });
    this.chromiumProvider = chromiumProvider;
  }
  get running() { return Boolean(this.#context); }
  async start() {
    if (this.#context) return this.status();
    if (this.#starting) return this.#starting;
    this.#starting = (async () => {
      await mkdir(this.profileDir, { recursive: true, mode: 0o700 });
      const chromium = await this.chromiumProvider();
      const context = await chromium.launchPersistentContext(this.profileDir, {
        headless: false, viewport: null, acceptDownloads: false,
      });
      this.#context = context;
      context.on("page", page => this.#attachPage(page));
      context.on("close", () => {
        if (this.#context === context) {
          this.#context = null;
          for (const binding of this.#bindings.values()) {
            try { this.registry.unregister(binding.target.id, { roomId: binding.target.roomId, hostId: this.hostId }); } catch {}
          }
          this.#pages.clear();
          this.#selectionRooms.clear();
          this.#targets.clear();
          this.#bindings.clear();
        }
      });
      for (const page of context.pages()) this.#attachPage(page);
      return this.status();
    })();
    try { return await this.#starting; }
    finally { this.#starting = null; }
  }
  async stop() {
    const context = this.#context;
    this.#context = null;
    for (const binding of this.#bindings.values()) {
      try { this.registry.unregister(binding.target.id, { roomId: binding.target.roomId, hostId: this.hostId }); } catch {}
    }
    this.#pages.clear();
    this.#selectionRooms.clear();
    this.#targets.clear();
    this.#bindings.clear();
    if (context) await context.close();
    return this.status();
  }
  #attachPage(page) {
    let id = this.#pageIds.get(page);
    if (!id) {
      id = randomUUID();
      this.#pageIds.set(page, id);
      this.#pages.set(id, page);
      page.on("close", () => {
        this.#pages.delete(id);
        this.#selectionRooms.delete(id);
        for (const [targetId, binding] of this.#bindings) {
          if (binding.pageId === id) {
            this.#bindings.delete(targetId);
            this.#targets.delete(targetId);
            try { this.registry.unregister(targetId, { roomId: binding.target.roomId, hostId: this.hostId }); } catch {}
          }
        }
      });
    }
    return id;
  }
  status() {
    return Object.freeze({ running: this.running, pages: this.#pages.size,
      capabilities: Object.freeze({ browserDraft: this.running, desktopAccessibility: false, androidAccessibility: false, terminal: false }) });
  }
  async listPages() {
    if (!this.#context) return [];
    const pages = [];
    for (const page of this.#context.pages()) {
      if (page.isClosed()) continue;
      const rawUrl = page.url();
      const safeUrl = safeSiteUrl(rawUrl);
      if (!safeUrl) continue;
      const pageId = this.#attachPage(page);
      let title = "Untitled tab";
      try { title = (await page.title()).trim().slice(0, 100) || title; } catch {}
      pages.push({ pageId, title, site: safeUrl.hostname, canSelect: true });
    }
    return pages;
  }
  #page(pageId) {
    const page = this.#pages.get(pageId);
    if (!page || page.isClosed() || !this.#context) throw new Error("browser_page_unavailable");
    const safeUrl = safeSiteUrl(page.url());
    if (!safeUrl) throw new Error("unsupported_page_protocol");
    return { page, url: safeUrl };
  }
  async startSelection(pageId, roomId) {
    const { page } = this.#page(pageId);
    if (typeof roomId !== "string" || !roomId.trim() || roomId.length > 120) throw new TypeError("group roomId required");
    this.#selectionRooms.set(pageId, roomId);
    try { await page.evaluate(installSelectionOverlay); }
    catch (error) { this.#selectionRooms.delete(pageId); throw error; }
    return { state: "pending", pageId, instruction: "Switch to the managed browser and drag around exactly one editable input." };
  }
  async getSelection(pageId) {
    const { page } = this.#page(pageId);
    const selection = await page.evaluate(() => window.__RM_BACKROOM_SELECTION_V1__ ?? null);
    if (!selection || typeof selection !== "object") return { state: "unavailable" };
    const output = { state: selection.state };
    if (selection.state === "selected") {
      output.tagName = String(selection.tagName || "").slice(0, 20);
      output.role = String(selection.role || "").slice(0, 40);
      output.ariaLabel = String(selection.ariaLabel || "").slice(0, 80);
    } else if (selection.state === "failed" || selection.state === "cancelled") {
      output.message = String(selection.message || (selection.state === "cancelled" ? "Selection cancelled" : "Selection failed")).slice(0, 160);
    }
    return output;
  }
  async registerSelectedTarget(pageId, roomId) {
    if (typeof roomId !== "string" || !roomId.trim() || roomId.length > 120) throw new TypeError("group roomId required");
    if (this.#selectionRooms.get(pageId) !== roomId) throw new Error("Selection belongs to another Rub Minds group; select the input again.");
    const { page, url } = this.#page(pageId);
    const selection = await page.evaluate(() => window.__RM_BACKROOM_SELECTION_V1__ ?? null);
    if (!selection || selection.state !== "selected" || typeof selection.selector !== "string" || selection.selector.length > 500) {
      throw new Error("Select one input in the managed browser first.");
    }
    const title = (await page.title().catch(() => "Browser input")).slice(0, 100);
    const target = {
      id: randomUUID(), roomId, hostId: this.hostId,
      spaceId: "browser:" + pageId, sessionId: pageId,
      appId: url.origin, identityFingerprint: url.origin + url.pathname + ":" + pageId,
      surface: "browser_tab", locatorKind: "dom", locatorValue: selection.selector, revision: 1,
    };
    const adapter = new BrowserDraftAdapter({
      page, origin: url.origin, path: url.pathname, selector: selection.selector,
      appId: target.appId, sessionId: pageId, identityFingerprint: target.identityFingerprint,
    });
    const guard = new LocalExecutionGuard({
      host: { hostId: this.hostId, deviceLabel: "Backroom local browser", surfaces: ["browser_tab"], operations: ["draft"] },
      adapter, permission: async () => true, isConnected: async () => this.#context !== null && !page.isClosed(),
    });
    const current = await adapter.probe({ target, operation: "draft" });
    if (!current.connected || !current.focused) throw new Error("Input must be visible, unique, and empty before registering the draft-only target.");
    this.registry.register(target);
    this.#targets.set(target.id, { target, pageId, title, site: url.hostname });
    this.#bindings.set(target.id, { target, pageId, page, adapter, guard });
    await page.evaluate(() => { const state = window.__RM_BACKROOM_SELECTION_V1__; if (state) delete window.__RM_BACKROOM_SELECTION_V1__; });
    this.#selectionRooms.delete(pageId);
    return { id: target.id, pageId, roomId: target.roomId, title, site: url.hostname, surface: "browser_tab", operations: ["draft"], submittedAutomatically: false };
  }
  listTargets() {
    return [...this.#targets.values()].map(({ target, pageId, title, site }) => ({
      id: target.id, pageId, roomId: target.roomId, title, site, surface: target.surface, operations: ["draft"],
    }));
  }
  async draft(targetId, text, { approved = false, roomId } = {}) {
    if (approved !== true) throw new Error("explicit draft approval required");
    if (typeof text !== "string" || !text.trim() || text.length > 10_000) throw new TypeError("draft text must be 1-10000 characters");
    const binding = this.#bindings.get(targetId);
    if (!binding) throw new Error("registered browser target unavailable");
    const target = binding.target;
    if (typeof roomId !== "string" || roomId !== target.roomId) throw new Error("Target belongs to a different Rub Minds group.");
    const command = {
      id: randomUUID(), eventId: randomUUID(), roomId: target.roomId,
      hostId: target.hostId, spaceId: target.spaceId, sessionId: target.sessionId,
      identityFingerprint: target.identityFingerprint, targetId: target.id,
      targetRevision: target.revision, operation: "draft", text,
    };
    this.dispatcher.enqueue(command);
    await this.dispatcher.step(command.id);
    const result = await this.dispatcher.step(command.id, { approved: true });
    return { state: result.state, reason: result.reason ?? null, result: result.result ?? null, submitted: false };
  }
}
