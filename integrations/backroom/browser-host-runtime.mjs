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
    if (url.username || url.password || url.protocol === "javascript:" || url.protocol === "file:") return null;
    if (url.protocol === "https:" || (url.protocol === "http:" && ["localhost","127.0.0.1"].includes(url.hostname))) return url;
  } catch {}
  return null;
};
export function installSelectionOverlay(attemptId = null) {
const isEditable = node => {
  if (!(node instanceof HTMLElement) || !node.isConnected) return false;
  if (node.closest('[aria-hidden="true"],[inert],[hidden]')) return false;
  if (("disabled" in node && node.disabled) || node.matches(":disabled")) return false;
  if ("readOnly" in node && node.readOnly) return false;
  if (node.getAttribute("aria-disabled") === "true" || node.getAttribute("aria-readonly") === "true") return false;
  // Backroom drafts natural-language prompts only, not structured form values.
  if (node instanceof HTMLInputElement && !["text","search","url","tel","email"].includes(node.type)) return false;
  // A role=textbox is not necessarily writable; only native fields and truly
  // contenteditable nodes are eligible for registration.
  if (!(node instanceof HTMLInputElement) && !(node instanceof HTMLTextAreaElement) && !node.isContentEditable) return false;
  const box = node.getBoundingClientRect();
  if (box.width <= 8 || box.height <= 8) return false;
  // Check ancestors too: opacity, inert, and visibility are not all inherited
  // in a way that a leaf-only style check can reliably detect.
  let current = node;
  while (current instanceof HTMLElement) {
    const style = getComputedStyle(current);
    if (current.hasAttribute("hidden") || current.hasAttribute("inert") ||
      current.getAttribute("aria-hidden") === "true" || style.display === "none" ||
      style.visibility === "hidden" || style.visibility === "collapse" ||
      Number(style.opacity) === 0 || style.pointerEvents === "none") return false;
    current = current.parentElement;
  }
  return true;
};
  const KEY = "__RM_BACKROOM_SELECTION_V1__";
  const OVERLAY_ID = "__rm_backroom_target_overlay_v1";
  const CLEANUP_KEY = "__RM_BACKROOM_SELECTION_CLEANUP_V1__";
  try {
    const cleanupPrevious = window[CLEANUP_KEY];
    if (typeof cleanupPrevious === "function") cleanupPrevious();
  } catch {}
  document.getElementById(OVERLAY_ID)?.remove();
  window.__RM_BACKROOM_ACTIVE_SELECTION_ATTEMPT_V1__ = attemptId;
  window[KEY] = { state: "pending", attemptId };
  window.__RM_BACKROOM_SELECTED_ELEMENT_V1__ = null;
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
  let cleanupOverlay = null;
  const endState = state => {
    window[KEY] = { ...state, attemptId };
    if (state.state !== "selected") window.__RM_BACKROOM_SELECTED_ELEMENT_V1__ = null;
    root.remove();
    window.removeEventListener("keydown", onKey, true);
    if (cleanupOverlay && window[CLEANUP_KEY] === cleanupOverlay) delete window[CLEANUP_KEY];
  };
  const onKey = event => {
    if (event.key === "Escape" && !finished) {
      finished = true;
      endState({ state: "cancelled" });
    }
  };
  cleanupOverlay = () => {
    if (!finished) {
      finished = true;
      endState({ state: "cancelled", message: "Selection was replaced by a new selection." });
      return;
    }
    root.remove();
    window.removeEventListener("keydown", onKey, true);
    if (window[CLEANUP_KEY] === cleanupOverlay) delete window[CLEANUP_KEY];
  };
  window[CLEANUP_KEY] = cleanupOverlay;
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
    const failureState = { state: "failed", message, attemptId };
    window[KEY] = failureState;
    window.__RM_BACKROOM_SELECTED_ELEMENT_V1__ = null;
    hint.textContent = message;
    hint.style.background = "#541d2b";
    window.setTimeout(() => {
      if (window[KEY] === failureState) endState(failureState);
      else {
        // A new overlay may have replaced this failed selection while its
        // feedback timer was pending. Clean only the old overlay/listener.
        root.remove();
        window.removeEventListener("keydown", onKey, true);
        if (window[CLEANUP_KEY] === cleanupOverlay) delete window[CLEANUP_KEY];
      }
    }, 1200);
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
  root.addEventListener("pointercancel", event => {
    if (!start || finished) return;
    event.preventDefault();
    start = null;
    rectangle.style.display = "none";
    finished = true;
    endState({ state: "cancelled", message: "Selection gesture was interrupted. Try again." });
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
    let selectionId;
    try { selectionId = window.crypto.randomUUID(); }
    catch { fail("Could not create a secure selection token. Reload the tab and try again."); return; }
    finished = true;
    window.__RM_BACKROOM_SELECTED_ELEMENT_V1__ = node;
    window[KEY] = {
      state: "selected", selector, tagName: node.tagName.toLowerCase(),
      role: node.getAttribute("role") || "", ariaLabel: node.getAttribute("aria-label") || "",
      selectionId, selectedAt: Date.now(), attemptId,
    };
    hint.textContent = "Input selected. Return to Rub Minds Backroom.";
    hint.style.background = "#153a32";
    window.setTimeout(() => root.remove(), 800);
    window.removeEventListener("keydown", onKey, true);
    if (window[CLEANUP_KEY] === cleanupOverlay) delete window[CLEANUP_KEY];
  });
  window.addEventListener("keydown", onKey, true);
  return { state: "pending" };
}

export class BrowserHostRuntime {
  #context = null;
  #starting = null;
  #stopping = null;
  #pages = new Map();
  #pageIds = new WeakMap();
  #targets = new Map();
  #bindings = new Map();
  #selectionRooms = new Map();
  constructor({ hostId, profileDir = join(homedir(), ".rub-minds", "backroom", "browser-profile"),
    chromiumProvider = async () => (await import("playwright")).chromium,
    headless = false, launchOptions = {} } = {}) {
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
    this.headless = headless === true;
    this.launchOptions = { ...launchOptions };
  }
  get running() { return Boolean(this.#context); }
  async start() {
    // Serialize start/stop so a Stop issued during browser launch cannot leave
    // a context running after the UI has reported it stopped.
    if (this.#stopping) await this.#stopping;
    if (this.#context) return this.status();
    if (this.#starting) return this.#starting;
    this.#starting = (async () => {
      await mkdir(this.profileDir, { recursive: true, mode: 0o700 });
      const chromium = await this.chromiumProvider();
      const context = await chromium.launchPersistentContext(this.profileDir, {
        ...this.launchOptions, headless: this.headless, viewport: null, acceptDownloads: false,
      });
      this.#context = context;
      context.on("page", page => this.#attachPage(page));
      context.on("close", () => {
        if (this.#context === context) {
          this.#context = null;
          for (const binding of this.#bindings.values()) {
            try { this.registry.unregister(binding.target.id, { roomId: binding.target.roomId, hostId: this.hostId }); } catch {}
            try { binding.nodeHandle?.dispose().catch(() => {}); } catch {}
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
    if (this.#stopping) return this.#stopping;
    this.#stopping = (async () => {
      // If Chromium is still starting, wait for its result then close it below.
      // A failed start is already stopped and should not prevent cleanup.
      if (this.#starting) {
        try { await this.#starting; } catch {}
      }
      const context = this.#context;
      this.#context = null;
      for (const binding of this.#bindings.values()) {
        try { this.registry.unregister(binding.target.id, { roomId: binding.target.roomId, hostId: this.hostId }); } catch {}
        try { await binding.nodeHandle?.dispose(); } catch {}
      }
      this.#pages.clear();
      this.#selectionRooms.clear();
      this.#targets.clear();
      this.#bindings.clear();
      if (context) await context.close();
      return this.status();
    })();
    try { return await this.#stopping; }
    finally { this.#stopping = null; }
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
            try { binding.nodeHandle?.dispose().catch(() => {}); } catch {}
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
  async openUrl(value) {
    if (!this.#context) throw new Error("Start the managed browser first.");
    if (typeof value !== "string" || value.length > 2048) throw new TypeError("Enter a valid HTTPS website URL.");
    const url = safeSiteUrl(value.trim());
    if (!url) throw new Error("Only HTTPS sites and explicit localhost/127.0.0.1 HTTP addresses are allowed.");
    const pages = this.#context.pages();
    // Reuse only a blank tab; do not silently replace a page containing user work.
    let page = pages.find(item => !item.isClosed() && item.url() === "about:blank");
    if (!page) page = await this.#context.newPage();
    await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const pageId = this.#attachPage(page);
    let title = "Untitled tab";
    try { title = (await page.title()).trim().slice(0, 100) || title; } catch {}
    const current = safeSiteUrl(page.url());
    if (!current) throw new Error("Navigation redirected to an unsupported destination.");
    return Object.freeze({ pageId, title, site: current.hostname, canSelect: true });
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
    const { page, url } = this.#page(pageId);
    if (typeof roomId !== "string" || !roomId.trim() || roomId.length > 120) throw new TypeError("group roomId required");
    const binding = {
      roomId, attemptId: randomUUID(),
      fingerprint: url.origin + url.pathname + url.search + url.hash + ":" + pageId,
    };
    this.#selectionRooms.set(pageId, binding);
    try { await page.evaluate(installSelectionOverlay, binding.attemptId); }
    catch (error) {
      if (this.#selectionRooms.get(pageId) === binding) this.#selectionRooms.delete(pageId);
      throw error;
    }
    if (this.#selectionRooms.get(pageId) !== binding) {
      await this.#clearSelectionAttempt(page, binding.attemptId);
      throw new Error("A newer selection attempt replaced this one. Start selection again.");
    }
    return { state: "pending", pageId, instruction: "Switch to the managed browser and drag around exactly one editable input." };
  }
  async #clearSelectionAttempt(page, attemptId) {
    try {
      return await page.evaluate(expectedAttemptId => {
        const state = window.__RM_BACKROOM_SELECTION_V1__;
        if (!state || state.attemptId !== expectedAttemptId) return false;
        document.getElementById("__rm_backroom_target_overlay_v1")?.remove();
        window.__RM_BACKROOM_SELECTED_ELEMENT_V1__ = null;
        delete window.__RM_BACKROOM_SELECTION_V1__;
        if (window.__RM_BACKROOM_ACTIVE_SELECTION_ATTEMPT_V1__ === expectedAttemptId) {
          window.__RM_BACKROOM_ACTIVE_SELECTION_ATTEMPT_V1__ = null;
        }
        return true;
      }, attemptId);
    } catch { return false; }
  }
  async getSelection(pageId) {
    const { page, url } = this.#page(pageId);
    const pending = this.#selectionRooms.get(pageId);
    if (!pending) return { state: "unavailable", message: "No active input selection. Start selection again." };
    const fingerprint = url.origin + url.pathname + url.search + url.hash + ":" + pageId;
    if (pending.fingerprint !== fingerprint) {
      if (this.#selectionRooms.get(pageId) === pending) this.#selectionRooms.delete(pageId);
      await this.#clearSelectionAttempt(page, pending.attemptId);
      return { state: "cancelled", message: "The conversation changed. Start selection again in the current tab." };
    }
    const selection = await page.evaluate(expectedAttemptId => {
      const current = window.__RM_BACKROOM_SELECTION_V1__ ?? null;
      return current?.attemptId === expectedAttemptId ? current : null;
    }, pending.attemptId);
    if (!selection || typeof selection !== "object") {
      return { state: "cancelled", message: "The selection expired or was replaced. Start selection again." };
    }
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
  async #clearBindingMarker(binding) {
    if (!binding) return;
    const stillUsed = [...this.#bindings.values()].some(other =>
      other.target.id !== binding.target.id && other.pageId === binding.pageId && other.marker === binding.marker);
    try {
      // Keep cleanup tied to the original ElementHandle. A webpage can copy a
      // data attribute to a replacement node; a selector alone is not identity.
      if (!stillUsed && binding.marker && binding.nodeHandle && !binding.page.isClosed()) {
        await binding.nodeHandle.evaluate((node, expected) => {
          if (node instanceof HTMLElement && node.getAttribute("data-rm-backroom-binding") === expected) {
            node.removeAttribute("data-rm-backroom-binding");
          }
        }, binding.marker);
      }
    } catch {} finally {
      try { await binding.nodeHandle?.dispose(); } catch {}
    }
  }
  async registerSelectedTarget(pageId, roomId) {
    if (typeof roomId !== "string" || !roomId.trim() || roomId.length > 120) throw new TypeError("group roomId required");
    await this.listTargets();
    const { page, url } = this.#page(pageId);
    const selectionBinding = this.#selectionRooms.get(pageId);
    const currentFingerprint = url.origin + url.pathname + url.search + url.hash + ":" + pageId;
    if (!selectionBinding || selectionBinding.roomId !== roomId || selectionBinding.fingerprint !== currentFingerprint) {
      if (selectionBinding && this.#selectionRooms.get(pageId) === selectionBinding) {
        this.#selectionRooms.delete(pageId);
        await this.#clearSelectionAttempt(page, selectionBinding.attemptId);
      }
      throw new Error("Selection belongs to another group or conversation; select the input again.");
    }
    const selection = await page.evaluate(expectedAttemptId => {
      const current = window.__RM_BACKROOM_SELECTION_V1__ ?? null;
      return current?.attemptId === expectedAttemptId ? current : null;
    }, selectionBinding.attemptId);
    if (!selection || selection.state !== "selected" || selection.attemptId !== selectionBinding.attemptId ||
      typeof selection.selector !== "string" || selection.selector.length > 500 ||
      !/^[a-f0-9-]{36}$/i.test(selection.selectionId)) {
      throw new Error("Select one input in the managed browser first.");
    }
    if (this.#selectionRooms.get(pageId) !== selectionBinding) {
      await this.#clearSelectionAttempt(page, selectionBinding.attemptId);
      throw new Error("Selection attempt changed while registering. Start selection again.");
    }

    // Keep the exact DOM element the drag gesture selected. A selector alone is
    // insufficient because React/SPA pages can replace an input between the
    // selection gesture and registration while reusing the same label/selector.
    const selectedHandle = await page.evaluateHandle(expected => {
      const state = window.__RM_BACKROOM_SELECTION_V1__;
      const node = window.__RM_BACKROOM_SELECTED_ELEMENT_V1__;
      return state?.state === "selected" && state.attemptId === expected.attemptId &&
        state.selectionId === expected.selectionId && node instanceof HTMLElement ? node : null;
    }, { attemptId: selectionBinding.attemptId, selectionId: selection.selectionId });
    const selectedNodeHandle = selectedHandle.asElement();
    if (!selectedNodeHandle) {
      await selectedHandle.dispose();
      throw new Error("The selected input changed. Drag around it again.");
    }

    let marker = null;
    let createdBindingMarker = false;
    let retainedNodeHandle = false;
    try {
      const title = (await page.title().catch(() => "Browser input")).slice(0, 100);
      const baseLocator = page.locator(selection.selector);
      if (await baseLocator.count() !== 1 || !(await baseLocator.isVisible()) || !(await baseLocator.isEnabled())) {
        throw new Error("Selected input is no longer unique, visible and enabled. Select it again.");
      }
      const sameNode = await selectedNodeHandle.evaluate((node, selector) => {
        if (!(node instanceof HTMLElement) || !node.isConnected || !node.matches(selector)) return false;
        try {
          const matches = document.querySelectorAll(selector);
          return matches.length === 1 && matches[0] === node;
        } catch { return false; }
      }, selection.selector).catch(() => false);
      if (!sameNode) throw new Error("The selected input changed after the drag gesture. Select it again.");

      const isMarkerOwnedBySelectedNode = async candidate => {
        for (const existingBinding of this.#bindings.values()) {
          if (existingBinding.pageId !== pageId || existingBinding.marker !== candidate) continue;
          const isSameNode = await existingBinding.nodeHandle.evaluate((node, expected) => {
            const state = window.__RM_BACKROOM_SELECTION_V1__;
            return node instanceof HTMLElement && node.isConnected &&
              node === window.__RM_BACKROOM_SELECTED_ELEMENT_V1__ &&
              state?.attemptId === expected.attemptId && state?.selectionId === expected.selectionId &&
              node.getAttribute("data-rm-backroom-binding") === expected.marker;
          }, { attemptId: selectionBinding.attemptId, selectionId: selection.selectionId, marker: candidate }).catch(() => false);
          if (isSameNode) return true;
        }
        return false;
      };
      marker = await selectedNodeHandle.getAttribute("data-rm-backroom-binding");
      if (marker && !/^[a-f0-9-]{36}$/i.test(marker)) {
        throw new Error("Selected input has a conflicting binding attribute. Reload the tab and select again.");
      }
      if (marker && !(await isMarkerOwnedBySelectedNode(marker))) {
        // A site can copy a valid-looking marker from an old composer. Ownership
        // is accepted only when a retained host handle is the exact selected node.
        const staleMarker = marker;
        const cleared = await selectedNodeHandle.evaluate((node, expected) => {
          if (!(node instanceof HTMLElement) || !node.isConnected ||
            node.getAttribute("data-rm-backroom-binding") !== expected) return false;
          node.removeAttribute("data-rm-backroom-binding");
          return true;
        }, staleMarker);
        if (!cleared) throw new Error("Could not clear an unowned DOM marker. Reload the tab and select again.");
        marker = null;
      }
      if (!marker) {
        const requestedMarker = randomUUID();
        const attach = await selectedNodeHandle.evaluate((node, value) => {
          if (!(node instanceof HTMLElement) || !node.isConnected) return { state: "unavailable", marker: "" };
          const current = node.getAttribute("data-rm-backroom-binding");
          if (current) return { state: "existing", marker: current };
          node.setAttribute("data-rm-backroom-binding", value);
          return { state: "bound", marker: value };
        }, requestedMarker);
        if (!attach || attach.state === "unavailable" || !/^[a-f0-9-]{36}$/i.test(attach.marker)) {
          throw new Error("Could not bind the selected DOM input. Select it again.");
        }
        marker = attach.marker;
        createdBindingMarker = attach.state === "bound";
        if (attach.state === "existing" && !(await isMarkerOwnedBySelectedNode(marker))) {
          const cleared = await selectedNodeHandle.evaluate((node, expected) => {
            if (!(node instanceof HTMLElement) || !node.isConnected ||
              node.getAttribute("data-rm-backroom-binding") !== expected) return false;
            node.removeAttribute("data-rm-backroom-binding");
            return true;
          }, marker);
          if (!cleared) throw new Error("Selected input acquired a conflicting marker. Select it again.");
          const replacementMarker = randomUUID();
          const rebound = await selectedNodeHandle.evaluate((node, value) => {
            if (!(node instanceof HTMLElement) || !node.isConnected || node.hasAttribute("data-rm-backroom-binding")) {
              return { state: "unavailable", marker: "" };
            }
            node.setAttribute("data-rm-backroom-binding", value);
            return { state: "bound", marker: value };
          }, replacementMarker);
          if (rebound?.state !== "bound" || rebound.marker !== replacementMarker) {
            throw new Error("Could not securely bind the selected input. Select it again.");
          }
          marker = replacementMarker;
          createdBindingMarker = true;
        }
      }

      const alreadyRegistered = [...this.#bindings.values()].find(binding =>
        binding.pageId === pageId && binding.marker === marker && binding.target.roomId === roomId);
      if (alreadyRegistered) {
        const clearedExistingSelection = await selectedNodeHandle.evaluate((node, expected) => {
          const state = window.__RM_BACKROOM_SELECTION_V1__;
          if (node instanceof HTMLElement && state?.attemptId === expected.attemptId &&
            state?.selectionId === expected.selectionId && window.__RM_BACKROOM_SELECTED_ELEMENT_V1__ === node) {
            window.__RM_BACKROOM_SELECTED_ELEMENT_V1__ = null;
            delete window.__RM_BACKROOM_SELECTION_V1__;
            if (window.__RM_BACKROOM_ACTIVE_SELECTION_ATTEMPT_V1__ === expected.attemptId) {
              window.__RM_BACKROOM_ACTIVE_SELECTION_ATTEMPT_V1__ = null;
            }
            return true;
          }
          return false;
        }, { attemptId: selectionBinding.attemptId, selectionId: selection.selectionId });
        if (!clearedExistingSelection || this.#selectionRooms.get(pageId) !== selectionBinding) {
          throw new Error("Selection changed while reusing the existing target. Select the input again.");
        }
        this.#selectionRooms.delete(pageId);
        const existing = this.#targets.get(alreadyRegistered.target.id);
        return { id: alreadyRegistered.target.id, pageId, roomId, title: existing?.title ?? title,
          site: existing?.site ?? url.hostname, surface: "browser_tab", operations: ["draft"], submittedAutomatically: false };
      }

      const boundSelector = selection.selector + '[data-rm-backroom-binding="' + marker + '"]';
      if (boundSelector.length > 700) throw new Error("Bound selector is too long. Select a simpler input.");
      const boundLocator = page.locator(boundSelector);
      if (await boundLocator.count() !== 1) throw new Error("The selected input changed while it was being registered. Select it again.");
      const sameBoundNode = await selectedNodeHandle.evaluate((node, binding) => {
        if (!(node instanceof HTMLElement) || !node.isConnected || !node.matches(binding.selector) ||
          node.getAttribute("data-rm-backroom-binding") !== binding.marker) return false;
        try {
          const matches = document.querySelectorAll(binding.selector);
          return matches.length === 1 && matches[0] === node;
        } catch { return false; }
      }, { selector: boundSelector, marker }).catch(() => false);
      if (!sameBoundNode) throw new Error("The input changed while its target was being registered. Select it again.");

      const target = {
        id: randomUUID(), roomId, hostId: this.hostId,
        spaceId: "browser:" + pageId, sessionId: pageId,
        appId: url.origin, identityFingerprint: url.origin + url.pathname + url.search + url.hash + ":" + pageId,
        surface: "browser_tab", locatorKind: "dom", locatorValue: boundSelector, revision: 1,
      };
      const adapter = new BrowserDraftAdapter({
        page, origin: url.origin, path: url.pathname, search: url.search, hash: url.hash, selector: boundSelector,
        appId: target.appId, sessionId: pageId, identityFingerprint: target.identityFingerprint,
        nodeHandle: selectedNodeHandle,
      });
      const guard = new LocalExecutionGuard({
        host: { hostId: this.hostId, deviceLabel: "Backroom local browser", surfaces: ["browser_tab"], operations: ["draft"] },
        adapter, permission: async () => true, isConnected: async () => this.#context !== null && !page.isClosed(),
      });
      const current = await adapter.probe({ target, operation: "draft" });
      if (!current.connected || !current.focused) throw new Error("Input must be visible, unique, and empty before registering the draft-only target.");
      const clearedSelection = await selectedNodeHandle.evaluate((node, expected) => {
        const state = window.__RM_BACKROOM_SELECTION_V1__;
        if (node instanceof HTMLElement && state?.attemptId === expected.attemptId &&
          state?.selectionId === expected.selectionId && window.__RM_BACKROOM_SELECTED_ELEMENT_V1__ === node) {
          window.__RM_BACKROOM_SELECTED_ELEMENT_V1__ = null;
          delete window.__RM_BACKROOM_SELECTION_V1__;
          if (window.__RM_BACKROOM_ACTIVE_SELECTION_ATTEMPT_V1__ === expected.attemptId) {
            window.__RM_BACKROOM_ACTIVE_SELECTION_ATTEMPT_V1__ = null;
          }
          return true;
        }
        return false;
      }, { attemptId: selectionBinding.attemptId, selectionId: selection.selectionId });
      if (!clearedSelection || this.#selectionRooms.get(pageId) !== selectionBinding) {
        throw new Error("Selection changed while registering the target. Select the input again.");
      }
      this.registry.register(target);
      this.#targets.set(target.id, { target, pageId, title, site: url.hostname });
      this.#bindings.set(target.id, { target, pageId, page, adapter, guard, marker, nodeHandle: selectedNodeHandle, baseSelector: selection.selector });
      this.#selectionRooms.delete(pageId);
      retainedNodeHandle = true;
      return { id: target.id, pageId, roomId: target.roomId, title, site: url.hostname,
        surface: "browser_tab", operations: ["draft"], submittedAutomatically: false };
    } finally {
      if (!retainedNodeHandle) {
        if (createdBindingMarker && marker) {
          try {
            await selectedNodeHandle.evaluate((node, expected) => {
              if (node instanceof HTMLElement && node.getAttribute("data-rm-backroom-binding") === expected) {
                node.removeAttribute("data-rm-backroom-binding");
              }
            }, marker);
          } catch {}
        }
        try {
          await selectedNodeHandle.evaluate(expected => {
            const state = window.__RM_BACKROOM_SELECTION_V1__;
            if (state?.attemptId === expected.attemptId && state?.selectionId === expected.selectionId) {
              window.__RM_BACKROOM_SELECTED_ELEMENT_V1__ = null;
              delete window.__RM_BACKROOM_SELECTION_V1__;
              if (window.__RM_BACKROOM_ACTIVE_SELECTION_ATTEMPT_V1__ === expected.attemptId) {
                window.__RM_BACKROOM_ACTIVE_SELECTION_ATTEMPT_V1__ = null;
              }
            }
          }, { attemptId: selectionBinding.attemptId, selectionId: selection.selectionId });
        } catch {}
        try { await selectedNodeHandle.dispose(); } catch {}
      }
    }
  }
  async listTargets() {
    // Revalidate both route and the exact DOM node marker. If a SPA swaps out a
    // composer in-place, the newly rendered input is never silently rebound.
    for (const [targetId, binding] of [...this.#bindings]) {
      let current = null, selectorCount = 0;
      try {
        if (!binding.page.isClosed()) {
          current = safeSiteUrl(binding.page.url());
          if (current) {
            const locator = binding.page.locator(binding.target.locatorValue);
            selectorCount = await locator.count();
            if (selectorCount === 1) {
              const sameNode = await binding.nodeHandle.evaluate((node, selector) => {
                if (!(node instanceof HTMLElement) || !node.isConnected || !node.matches(selector)) return false;
                try {
                  const matches = document.querySelectorAll(selector);
                  return matches.length === 1 && matches[0] === node;
                } catch { return false; }
              }, binding.target.locatorValue).catch(() => false);
              if (!sameNode) selectorCount = 0;
            }
          }
        }
      } catch {}
      const fingerprint = current
        ? current.origin + current.pathname + current.search + current.hash + ":" + binding.pageId
        : "";
      if (fingerprint !== binding.target.identityFingerprint || selectorCount !== 1) {
        this.#bindings.delete(targetId);
        this.#targets.delete(targetId);
        try { this.registry.unregister(targetId, { roomId: binding.target.roomId, hostId: this.hostId }); } catch {}
        await this.#clearBindingMarker(binding);
      }
    }
    return [...this.#targets.values()].map(({ target, pageId, title, site }) => ({
      id: target.id, pageId, roomId: target.roomId, title, site, surface: target.surface, operations: ["draft"],
    }));
  }
  async unregisterTarget(targetId, roomId) {
    const binding = this.#bindings.get(targetId);
    if (!binding || binding.target.roomId !== roomId) return false;
    this.#bindings.delete(targetId);
    this.#targets.delete(targetId);
    try { this.registry.unregister(targetId, { roomId: binding.target.roomId, hostId: this.hostId }); } catch {}
    await this.#clearBindingMarker(binding);
    return true;
  }
  async draft(targetId, text, { approved = false, roomId } = {}) {
    if (approved !== true) throw new Error("explicit draft approval required");
    if (typeof text !== "string" || !text.trim() || text.length > 10_000) throw new TypeError("draft text must be 1-10000 characters");
    await this.listTargets();
    const binding = this.#bindings.get(targetId);
    if (!binding) throw Object.assign(new Error("registered browser target unavailable"), { status: 404 });
    const target = binding.target;
    if (typeof roomId !== "string" || roomId !== target.roomId) {
      throw Object.assign(new Error("Target belongs to a different Rub Minds group."), { status: 409 });
    }
    const command = {
      id: randomUUID(), eventId: randomUUID(), roomId: target.roomId,
      hostId: target.hostId, spaceId: target.spaceId, sessionId: target.sessionId,
      identityFingerprint: target.identityFingerprint, targetId: target.id,
      targetRevision: target.revision, operation: "draft", text,
    };
    this.dispatcher.enqueue(command);
    try {
      await this.dispatcher.step(command.id);
      const result = await this.dispatcher.step(command.id, { approved: true });
      return { state: result.state, reason: result.reason ?? null, result: result.result ?? null, submitted: false };
    } finally {
      // The HTTP caller receives the final outcome synchronously; no polling API
      // retains this per-draft job. Release bounded in-memory dispatcher capacity.
      this.dispatcher.forget(command.id);
    }
  }
}
