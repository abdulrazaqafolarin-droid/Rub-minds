/**
 * Original-session wake runner.
 *
 * Runs beside an explicitly authenticated, user-authorized browser. A server
 * signal cannot itself execute a browser or create a turn in an idle provider
 * conversation. A live runner and a provider-specific bridge are required.
 *
 * The bridge must claim/check durable Rub Minds work before taking browser
 * action, honor the supplied AbortSignal, and use source-message IDs as
 * idempotency keys. This runner never exports provider cookies or credentials.
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
    if (typeof onStatus !== "function") throw new TypeError("onStatus must be a function");

    Object.assign(this, { bridge, wakeSource, heartbeatMs, maxReplies, maxConsecutiveErrors, onStatus });
    this.running = false;
    this.hasRun = false;
    this.replies = 0;
    this.controller = null;
  }

  emit(event) {
    // Diagnostics must never prevent cancellation or cleanup.
    try {
      this.onStatus(event);
    } catch {
      // Status listeners are best-effort and intentionally cannot control the runner.
    }
  }

  async run({ approved = false, signal } = {}) {
    if (!approved) throw new Error("Explicit approval required before waking an original AI session");
    if (this.running) throw new Error("Wake runner is already running");
    if (this.hasRun) throw new Error("Wake runner instances are single-use; construct a fresh runner to restart");

    this.hasRun = true;
    this.running = true;
    this.controller = new AbortController();
    const abort = () => this.controller?.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    let consecutiveErrors = 0;
    let finalStatus = "error";
    try {
      this.emit({ status: "running", replies: this.replies });
      if (this.controller.signal.aborted) {
        return { status: "stopped", replies: this.replies };
      }

      // Establish the original conversation's history baseline BEFORE listening
      // for new messages. This avoids replaying old group history, while messages
      // arriving during the hand-off remain eligible when the durable store is read.
      const initialization = await this.bridge.initialize?.({
        approved: true,
        signal: this.controller.signal,
      });
      if (this.controller.signal.aborted || initialization?.status === "cancelled") {
        finalStatus = "stopped";
        return { status: "stopped", replies: this.replies };
      }
      if (initialization?.status === "browser_closed") {
        finalStatus = "browser_closed";
        return { status: finalStatus, replies: this.replies };
      }

      // A bounded handshake prevents a dead Realtime subscription from making
      // this runner look alive when it has no listener.
      await this.wakeSource.start?.();

      while (!this.controller.signal.aborted && this.replies < this.maxReplies) {
        try {
          const bridgeCursor = this.bridge?.cursor;
          const cursor = bridgeCursor &&
            typeof bridgeCursor.created_at === "string" &&
            typeof bridgeCursor.id === "string"
            ? {
                after_created_at: bridgeCursor.created_at,
                after_message_id: bridgeCursor.id,
              }
            : null;
          const wake = await this.wakeSource.waitForWake({
            signal: this.controller.signal,
            timeoutMs: this.heartbeatMs,
            cursor,
          });
          if (this.controller.signal.aborted) break;
          if (wake?.status === "closed") {
            finalStatus = "source_closed";
            break;
          }
          if (wake?.status !== "timeout" && wake?.status !== "wake") {
            throw new Error("Wake source returned an invalid status");
          }

          // A timeout is a recovery heartbeat, never permission to send an
          // empty prompt. The adapter must check and claim a durable eligible task.
          const remainingReplies = this.maxReplies - this.replies;
          const result = await this.bridge.step({
            approved: true,
            signal: this.controller.signal,
            wakeReason: wake.status,
            remainingReplies,
          });

          if (!result || typeof result !== "object" || typeof result.status !== "string") {
            throw new Error("bridge.step returned an invalid result");
          }
          const validStatuses = new Set([
            "ok", "idle", "browser_closed", "limit_reached", "blocked",
            "auth_required", "thread_mismatch", "cancelled", "error", "busy", "baseline",
          ]);
          if (!validStatuses.has(result.status)) {
            throw new Error("bridge.step returned an unknown status");
          }
          if (!Number.isInteger(result.sent) || result.sent < 0 || result.sent > remainingReplies) {
            throw new Error("bridge.step returned an invalid sent count");
          }

          // Count any confirmed partial work before applying an error status.
          // Adapters that complete one reply and then fail must not desynchronize
          // this cap from the session bridge's own cumulative reply count.
          this.replies += result.sent;
          this.emit({ status: "running", replies: this.replies, lastResult: result });
          if (result.status === "error") {
            throw new Error(typeof result.message === "string" ? result.message : "Wake bridge reported an error");
          }
          consecutiveErrors = 0;

          // These states require operator intervention or signify a hard stop;
          // never keep poking a login challenge or an ambiguous conversation.
          if ([
            "browser_closed", "limit_reached", "blocked",
            "auth_required", "thread_mismatch", "cancelled",
          ].includes(result.status)) {
            finalStatus = result.status;
            this.emit({ status: finalStatus, replies: this.replies, lastResult: result });
            break;
          }
          if (this.replies >= this.maxReplies) {
            finalStatus = "limit_reached";
            break;
          }
        } catch (error) {
          if (this.controller.signal.aborted) break;
          consecutiveErrors += 1;
          this.emit({
            status: "error",
            consecutiveErrors,
            message: error instanceof Error ? error.message : "Wake bridge error",
          });
          if (consecutiveErrors >= this.maxConsecutiveErrors) throw error;
        }
      }

      return {
        status: this.controller.signal.aborted ? "stopped" : finalStatus,
        replies: this.replies,
      };
    } finally {
      signal?.removeEventListener("abort", abort);
      this.running = false;
      const controller = this.controller;
      this.controller = null;
      try {
        await this.wakeSource.close?.();
      } catch (error) {
        this.emit({
          status: "cleanup_error",
          message: error instanceof Error ? error.message : "Wake source cleanup failed",
        });
      }
      this.emit({
        status: controller?.signal.aborted ? "stopped" : finalStatus,
        replies: this.replies,
      });
    }
  }

  stop() {
    this.running = false;
    this.controller?.abort();
  }
}
