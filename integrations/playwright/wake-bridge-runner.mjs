/**
 * Original-session wake runner.
 *
 * This runs beside an explicitly authenticated, user-authorized Playwright
 * browser. HTTP/pg_cron can signal the wake source, but cannot itself execute
 * a browser or create a new turn in ChatGPT/Claude. A live runner is required.
 *
 * The wake source is transport-injected (e.g. authenticated Supabase Realtime
 * plus a bounded heartbeat). Provider page interaction remains the responsibility
 * of the existing Playwright adapter. No provider cookies are exported.
 */
export class OriginalSessionWakeRunner {
  constructor({
    bridge,
    wakeSource,
    heartbeatMs = 15000,
    maxReplies = 20,
    maxConsecutiveErrors = 3,
    onStatus = () => {},
  }) {
    if (!bridge || typeof bridge.step !== "function") {
      throw new TypeError("bridge.step is required");
    }
    if (!wakeSource || typeof wakeSource.waitForWake !== "function") {
      throw new TypeError("wakeSource.waitForWake is required");
    }
    if (!Number.isInteger(heartbeatMs) || heartbeatMs < 1000) {
      throw new RangeError("heartbeatMs must be an integer >= 1000");
    }
    if (!Number.isInteger(maxReplies) || maxReplies < 1) {
      throw new RangeError("maxReplies must be a positive integer");
    }
    if (!Number.isInteger(maxConsecutiveErrors) || maxConsecutiveErrors < 1) {
      throw new RangeError("maxConsecutiveErrors must be a positive integer");
    }
    Object.assign(this, { bridge, wakeSource, heartbeatMs, maxReplies, maxConsecutiveErrors, onStatus });
    this.running = false;
    this.replies = 0;
    this.controller = null;
  }

  async run({ approved = false, signal } = {}) {
    if (!approved) throw new Error("Explicit approval required before waking an original AI session");
    if (this.running) throw new Error("Wake runner is already running");
    this.running = true;
    this.controller = new AbortController();
    const abort = () => this.controller?.abort();
    signal?.addEventListener("abort", abort, { once: true });
    let consecutiveErrors = 0;
    this.onStatus({ status: "running", replies: this.replies });

    try {
      while (this.running && !this.controller.signal.aborted && this.replies < this.maxReplies) {
        try {
          // A timeout is a heartbeat, not a wake event. It lets the bridge recover
          // from dropped realtime notifications by checking the durable message store.
          const wake = await this.wakeSource.waitForWake({
            signal: this.controller.signal,
            timeoutMs: this.heartbeatMs,
          });
          if (this.controller.signal.aborted) break;
          if (wake?.status === "closed") break;
          if (wake?.status !== "timeout" && wake?.status !== "wake") {
            throw new Error("Wake source returned an invalid status");
          }

          const result = await this.bridge.step({
            approved: true,
            remainingReplies: this.maxReplies - this.replies,
          });
          const sent = Number.isInteger(result?.sent) && result.sent > 0 ? result.sent : 0;
          this.replies += sent;
          consecutiveErrors = 0;
          this.onStatus({ status: "running", replies: this.replies, lastResult: result });
          if (result?.status === "browser_closed" || result?.status === "limit_reached") break;
        } catch (error) {
          if (this.controller.signal.aborted) break;
          consecutiveErrors += 1;
          this.onStatus({
            status: "error",
            consecutiveErrors,
            message: error instanceof Error ? error.message : "Wake bridge error",
          });
          if (consecutiveErrors >= this.maxConsecutiveErrors) throw error;
        }
      }
      return {
        status: this.controller.signal.aborted ? "stopped" : "finished",
        replies: this.replies,
      };
    } finally {
      signal?.removeEventListener("abort", abort);
      this.running = false;
      this.controller = null;
      this.onStatus({ status: "stopped", replies: this.replies });
    }
  }

  stop() {
    this.running = false;
    this.controller?.abort();
  }
}
