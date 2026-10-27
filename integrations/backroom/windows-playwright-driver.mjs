import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { BACKROOM_PROVIDER_ORIGINS } from './session-manager.mjs';

const GROUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function exactOrigins(origins) {
  if (!Array.isArray(origins) || origins.length < 1 || origins.length > 10) throw new TypeError('approvedOrigins must contain 1-10 exact HTTPS origins');
  const normalized = origins.map(origin => {
    if (typeof origin !== 'string') throw new TypeError('Each approved origin must be a string');
    let parsed;
    try { parsed = new URL(origin); } catch { throw new TypeError('Each approved origin must be an HTTPS origin'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.origin !== origin ||
        parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new TypeError('Each approved origin must be an exact HTTPS origin');
    }
    return parsed.origin;
  });
  if (new Set(normalized).size !== normalized.length) throw new TypeError('approvedOrigins must not contain duplicates');
  return new Set(normalized);
}

function assertApprovedUrl(value, allowedOrigins) {
  if (typeof value !== 'string' || value.length > 2048) throw new TypeError('URL must contain 1-2048 characters');
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError('URL must be absolute'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Only HTTPS URLs without embedded credentials are allowed');
  if (!allowedOrigins.has(parsed.origin)) throw new Error('URL origin is not in the user-approved origin list');
  return parsed.href;
}

function profileName(groupId) {
  if (typeof groupId !== 'string' || !GROUP_ID.test(groupId)) throw new TypeError('groupId must be a UUID');
  return createHash('sha256').update(groupId.toLowerCase()).digest('hex').slice(0, 32);
}

/**
 * Windows managed-browser driver using Playwright Chromium.
 *
 * Every group gets a separate persistent profile directory. The profile stores
 * provider login state locally; it must not be copied to Rub Minds or another
 * group. The driver intentionally exposes only open/attach/inspect/close.
 *
 * A managed profile is a visible browser, not a clone of the provider app.
 * Existing-session attachment accepts a page supplied by a separately
 * authorized local adapter; it does not attach to arbitrary Chrome by itself.
 */
export class WindowsPlaywrightDriver {
  constructor({ chromium, profileRoot, timeoutMs = 30_000 } = {}) {
    if (!chromium || typeof chromium.launchPersistentContext !== 'function') {
      throw new TypeError('Playwright chromium with launchPersistentContext is required');
    }
    if (typeof profileRoot !== 'string' || !profileRoot.trim() || !path.isAbsolute(profileRoot)) {
      throw new TypeError('profileRoot must be an absolute local directory path');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) {
      throw new RangeError('timeoutMs must be between 1000 and 120000');
    }
    this.chromium = chromium;
    this.profileRoot = path.resolve(profileRoot);
    this.timeoutMs = timeoutMs;
    this.contexts = new Map();
    this.pendingContexts = new Map();
    this.allowedOriginsByPage = new WeakMap();
    this.navigationGuardedContexts = new WeakSet();
    this.sessions = new Map();
    this.pendingSessions = new Set();
    this.pendingSessionGroups = new Map();
    this.groupPendingCounts = new Map();
    this.groupWaiters = new Map();
    this.closingGroups = new Set();
    this.contextCleanupGroups = new Set();
    this.groupClosePromises = new Map();
  }

  beginPending(sessionId, groupId) {
    if (this.closingGroups.has(groupId)) throw new Error('Backroom group is closing');
    if (this.contextCleanupGroups.has(groupId)) throw new Error('Backroom group context is being cleaned up');
    if (this.sessions.has(sessionId) || this.pendingSessions.has(sessionId)) {
      throw new Error('sessionId is already open');
    }
    this.pendingSessions.add(sessionId);
    this.pendingSessionGroups.set(sessionId, groupId);
    this.groupPendingCounts.set(groupId, (this.groupPendingCounts.get(groupId) || 0) + 1);
  }

  async finishPending(sessionId, groupId) {
    this.pendingSessions.delete(sessionId);
    this.pendingSessionGroups.delete(sessionId);
    const count = this.groupPendingCounts.get(groupId) || 0;

    // If every concurrent open failed, the final operation must close the
    // otherwise-unused persistent context. Keep the group blocked until cleanup
    // finishes so a new open cannot attach to a context that is being closed.
    if (count <= 1) {
      const hasManagedSession = [...this.sessions.values()].some(
        item => item.groupId === groupId && item.mode === 'managed',
      );
      const context = this.contexts.get(groupId);
      if (context && !hasManagedSession && !this.closingGroups.has(groupId)) {
        this.contextCleanupGroups.add(groupId);
        try {
          await context.close();
          if (this.contexts.get(groupId) === context) this.contexts.delete(groupId);
        } catch {
          // Keep the context registered if closing failed; a later closeGroup
          // can retry cleanup without masking the original open error.
        } finally {
          this.contextCleanupGroups.delete(groupId);
        }
      }
      this.groupPendingCounts.delete(groupId);
      const waiters = this.groupWaiters.get(groupId) || [];
      this.groupWaiters.delete(groupId);
      for (const resolve of waiters) resolve();
    } else {
      this.groupPendingCounts.set(groupId, count - 1);
    }
  }

  waitForGroupIdle(groupId) {
    if ((this.groupPendingCounts.get(groupId) || 0) === 0) return Promise.resolve();
    return new Promise(resolve => {
      const waiters = this.groupWaiters.get(groupId) || [];
      waiters.push(resolve);
      this.groupWaiters.set(groupId, waiters);
    });
  }

  async profileDirectory(groupId) {
    const name = profileName(groupId);
    await mkdir(this.profileRoot, { recursive: true, mode: 0o700 });
    const realRoot = await realpath(this.profileRoot);
    const candidate = path.resolve(realRoot, name);
    if (!candidate.startsWith(realRoot + path.sep)) throw new Error('Profile path escaped the configured root');
    await mkdir(candidate, { recursive: true, mode: 0o700 });
    const realProfile = await realpath(candidate);
    if (!realProfile.startsWith(realRoot + path.sep)) throw new Error('Profile directory resolves outside the configured root');
    return realProfile;
  }

  async getContext(groupId) {
    const existing = this.contexts.get(groupId);
    if (existing) return existing;
    const pending = this.pendingContexts.get(groupId);
    if (pending) return pending;

    const creation = (async () => {
      const userDataDir = await this.profileDirectory(groupId);
      const context = await this.chromium.launchPersistentContext(userDataDir, {
        headless: false,
        acceptDownloads: false,
      });
      try {
        await this.installContextNavigationGuard(context);
        this.contexts.set(groupId, context);
        return context;
      } catch (error) {
        try { await context.close(); } catch { /* Preserve guard installation failure. */ }
        throw error;
      }
    })();
    this.pendingContexts.set(groupId, creation);
    try { return await creation; }
    finally { this.pendingContexts.delete(groupId); }
  }

  async installContextNavigationGuard(context) {
    if (this.navigationGuardedContexts.has(context)) return;
    if (typeof context.route !== 'function') {
      throw new TypeError('Playwright context must support route() for popup navigation containment');
    }
    await context.route('**/*', async route => {
      const request = route.request();
      if (!request.isNavigationRequest()) {
        await route.continue();
        return;
      }
      let frame, page, mainFrame;
      try {
        frame = request.frame();
        page = frame.page();
        mainFrame = page.mainFrame();
      } catch {
        await route.abort('blockedbyclient');
        return;
      }
      if (frame !== mainFrame) {
        await route.continue();
        return;
      }
      // Only a page explicitly registered by the managed-session driver has
      // an origin allowlist. New tabs/popups are denied before their first
      // top-level request, not just closed after the popup event.
      const allowedOrigins = this.allowedOriginsByPage.get(page);
      if (!allowedOrigins) {
        await route.abort('blockedbyclient');
        return;
      }
      try {
        assertApprovedUrl(request.url(), allowedOrigins);
        await route.continue();
      } catch {
        await route.abort('blockedbyclient');
      }
    });
    this.navigationGuardedContexts.add(context);
  }

  installNavigationGuard(page, allowedOrigins) {
    if (typeof page.route !== 'function' || typeof page.mainFrame !== 'function') {
      throw new TypeError('Playwright page must support route() and mainFrame() for navigation guards');
    }
    const mainFrame = page.mainFrame();
    return page.route('**/*', async route => {
      const request = route.request();
      if (!request.isNavigationRequest() || request.frame() !== mainFrame) {
        await route.continue();
        return;
      }
      try {
        assertApprovedUrl(request.url(), allowedOrigins);
        await route.continue();
      } catch {
        await route.abort('blockedbyclient');
      }
    });
  }

  installPopupGuard(page) {
    if (typeof page.on !== 'function') throw new TypeError('Playwright page must support popup events');
    // Popups are separate sessions. V1 closes them rather than allowing an
    // unregistered tab to escape the origin and session policy.
    page.on('popup', popup => {
      void Promise.resolve().then(() => popup.close()).catch(() => {});
    });
  }

  async openManaged({ groupId, sessionId, url, approvedOrigins, provider } = {}) {
    if (!GROUP_ID.test(groupId || '')) throw new TypeError('groupId must be a UUID');
    if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 200) throw new TypeError('sessionId must be a non-empty string');
    if (this.sessions.has(sessionId) || this.pendingSessions.has(sessionId)) throw new Error('sessionId is already open');
    const allowed = exactOrigins(approvedOrigins);
    if (provider !== 'website') {
      const providerOrigins = Object.hasOwn(BACKROOM_PROVIDER_ORIGINS, provider) ? BACKROOM_PROVIDER_ORIGINS[provider] : undefined;
      if (!providerOrigins) throw new Error('Unsupported AI provider');
      for (const origin of allowed) if (!providerOrigins.includes(origin)) throw new Error('Origin is outside the provider allowlist');
    }
    const target = assertApprovedUrl(url, allowed);
    this.beginPending(sessionId, groupId);
    let context;
    let page;
    let wasContextEmpty = false;
    try {
      context = await this.getContext(groupId);
      wasContextEmpty = ![...this.sessions.values()].some(item => item.groupId === groupId && item.mode === 'managed');
      page = await context.newPage();
      this.allowedOriginsByPage.set(page, allowed);
      await this.installNavigationGuard(page, allowed);
      this.installPopupGuard(page);
      page.setDefaultNavigationTimeout?.(this.timeoutMs);
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
      const current = await this.inspectPage(page);
      if (current.isClosed || !allowed.has(current.origin)) {
        throw new Error('The browser did not remain on an approved HTTPS origin');
      }
      if (this.closingGroups.has(groupId)) {
        throw new Error('Backroom group began closing before this session could be registered');
      }
      const handle = Object.freeze({ sessionId, groupId, mode: 'managed', page });
      this.sessions.set(sessionId, { groupId, mode: 'managed', page, approvedOrigins: allowed, provider });
      return handle;
    } catch (error) {
      if (page) {
        this.allowedOriginsByPage.delete(page);
        try { await page.close(); } catch { /* Preserve primary error. */ }
      }
      if (context && wasContextEmpty) {
        const stillUsed = [...this.sessions.values()].some(item => item.groupId === groupId && item.mode === 'managed');
        const anotherOpenPending = [...this.pendingSessionGroups].some(([pendingId, pendingGroup]) => pendingId !== sessionId && pendingGroup === groupId);
        if (!stillUsed && !anotherOpenPending) {
          try { await context.close(); } catch { /* Preserve primary error. */ }
          this.contexts.delete(groupId);
        }
      }
      throw error;
    } finally {
      await this.finishPending(sessionId, groupId);
    }
  }

  async attachExisting({ groupId, sessionId, page, approvedOrigins, provider } = {}) {
    if (!GROUP_ID.test(groupId || '')) throw new TypeError('groupId must be a UUID');
    if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 200) throw new TypeError('sessionId must be a non-empty string');
    if (!page || typeof page.url !== 'function' || typeof page.isClosed !== 'function') throw new TypeError('An explicitly selected Playwright page is required');
    if (this.sessions.has(sessionId) || this.pendingSessions.has(sessionId)) throw new Error('sessionId is already open');
    const allowed = exactOrigins(approvedOrigins);
    if (provider !== 'website') {
      const providerOrigins = Object.hasOwn(BACKROOM_PROVIDER_ORIGINS, provider) ? BACKROOM_PROVIDER_ORIGINS[provider] : undefined;
      if (!providerOrigins) throw new Error('Unsupported AI provider');
      for (const origin of allowed) if (!providerOrigins.includes(origin)) throw new Error('Origin is outside the provider allowlist');
    }
    this.beginPending(sessionId, groupId);
    try {
      const current = await this.inspectPage(page);
      if (current.isClosed || !allowed.has(current.origin)) throw new Error('Selected page is closed or outside the approved origin list');
      if (this.closingGroups.has(groupId)) throw new Error('Backroom group began closing before this session could be registered');
      const handle = Object.freeze({ sessionId, groupId, mode: 'attach_existing', page });
      this.sessions.set(sessionId, { groupId, mode: 'attach_existing', page, approvedOrigins: allowed, provider });
      return handle;
    } finally {
      this.finishPending(sessionId, groupId);
    }
  }

  async inspectPage(page) {
    if (!page || typeof page.isClosed !== 'function') throw new TypeError('Invalid page handle');
    if (page.isClosed()) return { isClosed: true, origin: null, url: null };
    const value = page.url();
    let origin = null;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) origin = parsed.origin;
    } catch { /* Invalid or non-HTTPS URLs have no authorized origin. */ }
    return { isClosed: false, origin, url: value };
  }

  async inspect(handle) {
    if (!handle || typeof handle.sessionId !== 'string') throw new TypeError('Invalid session handle');
    const tracked = this.sessions.get(handle.sessionId);
    if (!tracked || tracked.page !== handle.page || tracked.groupId !== handle.groupId) {
      throw new Error('Session handle is not registered by this driver');
    }
    const current = await this.inspectPage(tracked.page);
    return {
      isClosed: current.isClosed,
      url: current.url,
      origin: current.origin,
    };
  }

  async closeSession(handle) {
    if (!handle || typeof handle.sessionId !== 'string') return;
    const tracked = this.sessions.get(handle.sessionId);
    if (!tracked || tracked.page !== handle.page) return;
    this.sessions.delete(handle.sessionId);
    if (tracked.mode === 'managed') {
      this.allowedOriginsByPage.delete(tracked.page);
      try { if (!tracked.page.isClosed()) await tracked.page.close(); }
      finally {
        const remaining = [...this.sessions.values()].some(
          item => item.groupId === tracked.groupId && item.mode === 'managed',
        );
        const anotherOpenPending = [...this.pendingSessionGroups.values()].some(
          groupId => groupId === tracked.groupId,
        );
        // Do not shut down a group's shared context while another open is in
        // progress. The final pending operation will clean it up if it fails.
        if (!remaining && !anotherOpenPending && !this.closingGroups.has(tracked.groupId)) {
          const context = this.contexts.get(tracked.groupId);
          if (context) {
            // Prevent a concurrent open from reusing a context while it closes.
            this.contextCleanupGroups.add(tracked.groupId);
            try {
              await context.close();
              if (this.contexts.get(tracked.groupId) === context) this.contexts.delete(tracked.groupId);
            } finally {
              this.contextCleanupGroups.delete(tracked.groupId);
            }
          }
        }
      }
    }
    // Attaching to an existing session unregisters the handle; it never closes the user's page.
  }

  async closeGroup(groupId) {
    if (!GROUP_ID.test(groupId || '')) throw new TypeError('groupId must be a UUID');
    const existingClose = this.groupClosePromises.get(groupId);
    if (existingClose) return existingClose;
    this.closingGroups.add(groupId);
    const closing = (async () => {
      // Block new opens now; close only after in-flight opens have either
      // registered or cleaned up their uncommitted pages.
      await this.waitForGroupIdle(groupId);
      const entries = [...this.sessions.entries()].filter(([, item]) => item.groupId === groupId);
      for (const [sessionId, item] of entries) {
        this.sessions.delete(sessionId);
        if (item.mode === 'managed') this.allowedOriginsByPage.delete(item.page);
        if (item.mode === 'managed' && !item.page.isClosed()) {
          try { await item.page.close(); } catch { /* Continue cleanup. */ }
        }
      }
      const context = this.contexts.get(groupId);
      if (context) {
        await context.close();
        if (this.contexts.get(groupId) === context) this.contexts.delete(groupId);
      }
      // Existing user pages are only unregistered; they are never closed.
    })().finally(() => {
      this.closingGroups.delete(groupId);
      this.groupClosePromises.delete(groupId);
    });
    this.groupClosePromises.set(groupId, closing);
    return closing;
  }
}
