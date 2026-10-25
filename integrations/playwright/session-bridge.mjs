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

function isSafeToRetry(error) {
  return Boolean(error && typeof error === "object" && (
    error.safeToRetry === true || error.submissionState === "not_submitted"
  ));
}

function errorOutcome(error, sent, processed) {
  return {
    status: "error",
    sent,
    processed,
    message: error instanceof Error ? error.message : "Session bridge error",
  };
}

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
    processExistingMessages = false,
    maxSeenMessageIds = 2000,
  }) {
    if (!page || typeof page.isClosed !== "function" || !adapter || typeof adapter.ask !== "function") {
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
    if (typeof processExistingMessages !== "boolean") {
      throw new TypeError("processExistingMessages must be a boolean");
    }
    if (!Number.isInteger(maxSeenMessageIds) || maxSeenMessageIds < 50 || maxSeenMessageIds > 100000) {
      throw new RangeError("maxSeenMessageIds must be between 50 and 100000");
    }

    Object.assign(this, {
      page, adapter, readMessages, sendMessage, participantId,
      intervalMs, maxReplies, maxMessagesPerStep, processExistingMessages, maxSeenMessageIds,
    });
    this.running = false;
    this.stepInProgress = false;
    this.initialized = false;
    this.replies = 0;
    this.seen = new Set();
    // Keep completed provider replies pending until Rub Minds acknowledges them.
    // Retrying the same source_message_id is safe when the server enforces dedupe.
    this.pendingResponses = new Map();
    // Ambiguous provider outcomes must stop automation rather than risk duplicate prompts.
    this.blockedMessage = null;
  }

  markSeen(messageId) {
    if (typeof messageId !== "string" || !messageId) return;
    if (this.seen.has(messageId)) this.seen.delete(messageId);
    this.seen.add(messageId);
    while (this.seen.size > this.maxSeenMessageIds) {
      const oldest = this.seen.values().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }

  /**
   * Establish a startup baseline before subscribing to wake notifications.
   * Existing history is ignored by default. Enable processExistingMessages only
   * when the owner explicitly wants a newly connected bridge to process backlog.
   */
  async initialize({ approved = false, signal } = {}) {
    if (!approved) {
      throw new Error("Explicit approval required before accessing an AI browser session");
    }
    if (this.initialized) return { status: "ready", baselineMessages: 0, alreadyInitialized: true };
    if (signal?.aborted) return { status: "cancelled", baselineMessages: 0 };
    if (this.page.isClosed()) return { status: "browser_closed", baselineMessages: 0 };

    if (this.processExistingMessages) {
      this.initialized = true;
      return { status: "ready", baselineMessages: 0, processExistingMessages: true };
    }

    const result = await this.readMessages({ signal });
    if (signal?.aborted) return { status: "cancelled", baselineMessages: 0 };
    if (!result || !Array.isArray(result.messages)) {
      throw new Error("Invalid group message response while establishing startup baseline");
    }
    let baselineMessages = 0;
    for (const message of result.messages) {
      if (!message || typeof message.id !== "string" || !message.id) continue;
      this.markSeen(message.id);
      baselineMessages++;
    }
    this.initialized = true;
    return { status: "baseline", baselineMessages };
  }

  async step(options = {}) {
    if (this.stepInProgress) return { status: "busy", sent: 0, processed: 0 };
    this.stepInProgress = true;
    try {
      return await this.#step(options);
    } finally {
      this.stepInProgress = false;
    }
  }

  async #step({ approved = false, remainingReplies = this.maxReplies - this.replies, signal } = {}) {
    if (!approved) {
      throw new Error("Explicit approval required before accessing an AI browser session");
    }
    if (!Number.isInteger(remainingReplies) || remainingReplies < 0) {
      throw new RangeError("remainingReplies must be a non-negative integer");
    }
    if (signal?.aborted) return { status: "cancelled", sent: 0, processed: 0 };
    if (this.blockedMessage) {
      return {
        status: "blocked",
        sent: 0,
        processed: 0,
        blockedMessageId: this.blockedMessage.messageId,
        reason: this.blockedMessage.reason,
      };
    }

    const effectiveLimit = Math.min(this.maxReplies, this.replies + remainingReplies);
    if (this.replies >= effectiveLimit) return { status: "limit_reached", sent: 0, processed: 0 };
    if (this.page.isClosed()) return { status: "browser_closed", sent: 0, processed: 0 };

    const initialization = await this.initialize({ approved, signal });
    if (initialization.status === "cancelled" || initialization.status === "browser_closed") {
      return { status: initialization.status, sent: 0, processed: 0 };
    }
    if (initialization.status === "baseline") {
      return {
        status: "baseline",
        sent: 0,
        processed: 0,
        baselineMessages: initialization.baselineMessages,
      };
    }

    let sent = 0;
    let processed = 0;

    // Deliver completed replies before prompting the provider again. If a send
    // failed ambiguously, resend the same body with the same idempotency key.
    for (const [messageId, response] of this.pendingResponses) {
      if (signal?.aborted) return { status: "cancelled", sent, processed };
      if (this.replies >= effectiveLimit || sent >= remainingReplies) break;
      try {
        await this.sendMessage(response, messageId, { signal });
      } catch (error) {
        if (sent > 0) return errorOutcome(error, sent, processed);
        throw error;
      }
      this.pendingResponses.delete(messageId);
      this.replies++;
      sent++;
    }
    if (this.replies >= effectiveLimit) return { status: "limit_reached", sent, processed };
    if (signal?.aborted) return { status: "cancelled", sent, processed };

    let result;
    try {
      result = await this.readMessages({ signal });
    } catch (error) {
      if (sent > 0) return errorOutcome(error, sent, processed);
      throw error;
    }
    if (!result || !Array.isArray(result.messages)) {
      const error = new Error("Invalid group message response");
      if (sent > 0) return errorOutcome(error, sent, processed);
      throw error;
    }

    for (const message of result.messages) {
      if (signal?.aborted) return { status: "cancelled", sent, processed };
      if (this.replies >= effectiveLimit || processed >= this.maxMessagesPerStep) break;
      if (!message || typeof message.id !== "string" || typeof message.body !== "string") continue;
      if (this.seen.has(message.id) || this.pendingResponses.has(message.id)) continue;

      // Mark every observed ID once, including ignored messages, so polling does
      // not repeatedly reconsider the same event.
      this.markSeen(message.id);
      if (this.participantId && message.sender_id === this.participantId) continue;
      if (message.sender_kind !== "human" && !AI_KINDS.has(message.sender_kind)) continue;

      // Optional server-supplied depth is respected when available. The server
      // remains responsible for global turn limits across multiple AI bridges.
      if (Number.isInteger(message.turn_depth) && message.turn_depth >= 8) continue;

      processed++;
      let response;
      try {
        response = await this.adapter.ask(this.page, message.body, {
          messageId: message.id,
          senderKind: message.sender_kind,
          senderName: message.display_name ?? message.sender_name ?? null,
          signal,
        });
      } catch (error) {
        if (signal?.aborted) {
          this.blockedMessage = { messageId: message.id, reason: "provider_outcome_unknown_after_cancel" };
          return { status: "cancelled", sent, processed, blockedMessageId: message.id };
        }
        if (isSafeToRetry(error)) {
          // Retry only when the adapter explicitly guarantees no prompt was sent.
          this.seen.delete(message.id);
          if (sent > 0) return errorOutcome(error, sent, processed);
          throw error;
        }
        this.blockedMessage = { messageId: message.id, reason: "provider_outcome_unknown" };
        return {
          status: "blocked",
          sent,
          processed,
          blockedMessageId: message.id,
          reason: "provider_outcome_unknown",
        };
      }

      if (typeof response !== "string" || !response.trim()) {
        this.blockedMessage = { messageId: message.id, reason: "provider_response_empty_or_incomplete" };
        return {
          status: "blocked",
          sent,
          processed,
          blockedMessageId: message.id,
          reason: "provider_response_empty_or_incomplete",
        };
      }

      // Save before the send call so a transient/ambiguous transport failure
      // cannot force a second provider prompt on the next step.
      this.pendingResponses.set(message.id, response.trim());
      if (signal?.aborted) return { status: "cancelled", sent, processed, pendingDelivery: true };

      try {
        await this.sendMessage(response.trim(), message.id, { signal });
      } catch (error) {
        if (sent > 0) return errorOutcome(error, sent, processed);
        throw error;
      }
      this.pendingResponses.delete(message.id);
      this.replies++;
      sent++;
    }

    return { status: "ok", sent, processed };
  }

  async run({ approved = false, signal } = {}) {
    if (!approved) throw new Error("Explicit approval required");
    if (this.running) throw new Error("Bridge already running");
    this.running = true;
    try {
      const initialization = await this.initialize({ approved, signal });
      if (initialization.status === "cancelled" || initialization.status === "browser_closed") {
        return { status: initialization.status, replies: this.replies };
      }
      while (this.running && !signal?.aborted && this.replies < this.maxReplies) {
        const outcome = await this.step({
          approved,
          remainingReplies: this.maxReplies - this.replies,
          signal,
        });
        if ([
          "browser_closed", "limit_reached", "blocked", "cancelled",
        ].includes(outcome.status)) break;
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
