/**
 * Hybrid Playwright session coordinator.
 *
 * Preferred route: an explicitly connected original AI browser session.
 * Fallback route: a separate browser context/session, manually authenticated
 * by its owner and initialized with an approved context brief.
 *
 * Provider-specific adapters are injected; this module does not scrape
 * undocumented selectors, bypass authentication, or export browser cookies.
 */
export class HybridSessionCoordinator {
  constructor({ originalSession, independentSessionFactory, maxReplies = 20, onModeChange = () => {} }) {
    if (!Number.isInteger(maxReplies) || maxReplies < 1) throw new RangeError("maxReplies must be positive");
    if (originalSession && typeof originalSession.step !== "function") throw new TypeError("originalSession.step required");
    if (independentSessionFactory !== undefined && typeof independentSessionFactory !== "function") {
      throw new TypeError("independentSessionFactory must be a function");
    }
    Object.assign(this, { originalSession, independentSessionFactory, maxReplies, onModeChange });
    this.active = null;
    this.mode = "stopped";
    this.replies = 0;
  }

  async start({ approved = false, allowIndependentFallback = false, contextBrief = "" } = {}) {
    if (!approved) throw new Error("Explicit user approval is required");
    if (this.active) throw new Error("Hybrid session already active");
    if (this.originalSession) {
      try {
        const ready = await this.originalSession.ready();
        if (ready) {
          this.active = this.originalSession;
          this.mode = "original";
          this.onModeChange({ mode: this.mode });
          return { mode: this.mode, status: "ready" };
        }
      } catch { /* controlled fallback below, only when user allowed it */ }
    }
    if (!allowIndependentFallback || !this.independentSessionFactory) {
      this.mode = "waiting_for_original";
      this.onModeChange({ mode: this.mode });
      return { mode: this.mode, status: "waiting_for_original" };
    }
    // Factory must create a separate context; user authenticates there directly.
    // No original-session cookies, tokens, or local storage are copied.
    const session = await this.independentSessionFactory({ contextBrief });
    if (!session || typeof session.ready !== "function" || typeof session.step !== "function") {
      throw new Error("Independent session factory returned an invalid session");
    }
    const ready = await session.ready();
    if (!ready) {
      await session.close?.();
      this.mode = "waiting_for_independent_auth";
      this.onModeChange({ mode: this.mode });
      return { mode: this.mode, status: "waiting_for_independent_auth" };
    }
    this.active = session;
    this.mode = "independent";
    this.onModeChange({ mode: this.mode });
    return { mode: this.mode, status: "ready" };
  }

  async step({ approved = false } = {}) {
    if (!approved) throw new Error("Explicit user approval is required");
    if (!this.active) return { mode: this.mode, status: "not_connected" };
    if (this.replies >= this.maxReplies) return { mode: this.mode, status: "limit_reached" };
    const result = await this.active.step({ approved, remainingReplies: this.maxReplies - this.replies });
    const sent = Number.isInteger(result?.sent) && result.sent > 0 ? result.sent : 0;
    this.replies += sent;
    return { mode: this.mode, ...result, totalReplies: this.replies };
  }

  async stop() {
    const session = this.active;
    this.active = null;
    this.mode = "stopped";
    this.onModeChange({ mode: this.mode });
    await session?.close?.();
  }
}
