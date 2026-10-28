/**
 * Playwright-backed Rub Minds session bridge foundation.
 *
 * Transports messages to an explicitly authorized existing AI browser session.
 * Provider-specific DOM adapters are injected; this module does not guess
 * provider selectors or claim to create browser capabilities by itself.
 *
 * This is a bounded in-process loop, NOT hosted 24/7 infrastructure.
 */
const AI_KINDS = new Set(["original_session", "model", "external_agent"]);

export class PlaywrightSessionBridge {
  constructor({
    page,
    adapter,
    readMessages,
    sendMessage,
    participantId = null,
    intervalMs = 5000,
    maxReplies = 20,
    maxMessagesPerStep = 1,
    allowAiHandoff = false,
    maxAiHandoffDepth = 2,
    maxSeenMessages = 5000,
  }) {
    if (!page || !adapter || typeof adapter.ask !== "function") {
      throw new TypeError("Playwright page and AI adapter.ask are required");
    }
    if (typeof readMessages !== "function" || typeof sendMessage !== "function") {
      throw new TypeError("Message transport functions required");
    }
    if (participantId !== null && (typeof participantId !== "string" || !participantId)) {
      throw new TypeError("participantId must be a non-empty string when provided");
    }
    if (!Number.isInteger(intervalMs) || intervalMs < 1000) {
      throw new RangeError("intervalMs must be >= 1000");
    }
    if (!Number.isInteger(maxReplies) || maxReplies < 1) {
      throw new RangeError("maxReplies must be positive");
    }
    if (!Number.isInteger(maxMessagesPerStep) || maxMessagesPerStep < 1 || maxMessagesPerStep > 10) {
      throw new RangeError("maxMessagesPerStep must be between 1 and 10");
    }
    if (typeof allowAiHandoff !== "boolean") {
      throw new TypeError("allowAiHandoff must be an explicit boolean");
    }
    if (!Number.isInteger(maxAiHandoffDepth) || maxAiHandoffDepth < 1 || maxAiHandoffDepth > 8) {
      throw new RangeError("maxAiHandoffDepth must be between 1 and 8");
    }
    if (!Number.isSafeInteger(maxSeenMessages) || maxSeenMessages < 1 || maxSeenMessages > 100_000) {
      throw new RangeError("maxSeenMessages must be between 1 and 100000");
    }

    Object.assign(this, {
      page, adapter, readMessages, sendMessage, participantId,
      intervalMs, maxReplies, maxMessagesPerStep, allowAiHandoff, maxAiHandoffDepth, maxSeenMessages,
    });
    this.running = false;
    this.replies = 0;
    this.seen = new Set();
  }

  async step({ approved = false, remainingReplies = this.maxReplies - this.replies } = {}) {
    if (!approved) {
      throw new Error("Explicit approval required before accessing an AI browser session");
    }
    if (!Number.isInteger(remainingReplies) || remainingReplies < 0) {
      throw new RangeError("remainingReplies must be a non-negative integer");
    }
    const effectiveLimit = Math.min(this.maxReplies, this.replies + remainingReplies);
    if (this.replies >= effectiveLimit) return { status: "limit_reached" };
    if (this.page.isClosed()) return { status: "browser_closed" };

    const result = await this.readMessages();
    if (!result || !Array.isArray(result.messages)) {
      throw new Error("Invalid group message response");
    }

    let sent = 0;
    let processed = 0;
    for (const message of result.messages) {
      if (this.replies >= effectiveLimit || processed >= this.maxMessagesPerStep) break;
      if (!message || typeof message.id !== "string" || typeof message.body !== "string") continue;
      if (this.seen.has(message.id)) continue;

      // Keep the per-session dedupe set bounded. On exhaustion, stop visibly
      // instead of evicting old IDs and risking duplicate provider work on a
      // replayed message. The caller must explicitly reset/review the session.
      if (this.seen.size >= this.maxSeenMessages) {
        return { status: "seen_budget_reached", sent, processed,
          reason: "Seen-message budget reached; stop and review session state before restarting." };
      }
      // Mark every observed ID once, including ignored messages, so polling does
      // not repeatedly reconsider the same event.
      this.seen.add(message.id);
      if (this.participantId && message.sender_id === this.participantId) continue;

      // Human-origin messages are the safe default. AI-to-AI routing must be
      // deliberately enabled and must carry a server-supplied turn depth; missing
      // depth is not treated as zero because that would make loops unbounded.
      if (message.sender_kind === "human") {
        // Human messages may begin a fresh task and do not inherit AI handoff depth.
      } else if (AI_KINDS.has(message.sender_kind)) {
        if (!this.allowAiHandoff) continue;
        if (!Number.isInteger(message.turn_depth) || message.turn_depth < 0 ||
          message.turn_depth >= this.maxAiHandoffDepth) continue;
      } else {
        continue;
      }

      processed++;
      try {
        const response = await this.adapter.ask(this.page, message.body, {
          messageId: message.id,
          senderKind: message.sender_kind,
          senderName: message.display_name ?? null,
        });
        if (typeof response !== "string" || !response.trim()) continue;

        // The transport should use source message IDs as idempotency keys. If
        // the send result is ambiguous, a retry must not create a duplicate.
        await this.sendMessage(response.trim(), message.id);
        this.replies++;
        sent++;
      } catch (error) {
        // Provider failures are safe to retry. For ambiguous send failures the
        // backend's source_message_id dedupe is the final protection.
        this.seen.delete(message.id);
        throw error;
      }
    }
    return { status: "ok", sent, processed };
  }

  async run({ approved = false, signal } = {}) {
    if (!approved) throw new Error("Explicit approval required");
    if (this.running) throw new Error("Bridge already running");
    this.running = true;
    try {
      while (this.running && !signal?.aborted && this.replies < this.maxReplies) {
        const outcome = await this.step({ approved, remainingReplies: this.maxReplies - this.replies });
        if (outcome.status === "browser_closed" || outcome.status === "limit_reached" || outcome.status === "seen_budget_reached") break;
        await new Promise(resolve => setTimeout(resolve, this.intervalMs));
      }
    } finally {
      this.running = false;
    }
  }

  stop() {
    this.running = false;
  }
}
