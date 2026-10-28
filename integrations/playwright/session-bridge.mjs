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
    roomId,
    intervalMs = 5000,
    maxReplies = 20,
    maxMessagesPerStep = 1,
    maxMessageChars = 12_000,
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
    if (typeof roomId !== "string" || !roomId.trim() || roomId.length > 120) {
      throw new TypeError("roomId must identify the one Rub Minds group this bridge is allowed to process");
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
    if (!Number.isSafeInteger(maxMessageChars) || maxMessageChars < 1 || maxMessageChars > 50_000) {
      throw new RangeError("maxMessageChars must be between 1 and 50000");
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
      page, adapter, readMessages, sendMessage, participantId, roomId,
      intervalMs, maxReplies, maxMessagesPerStep, maxMessageChars, allowAiHandoff, maxAiHandoffDepth, maxSeenMessages,
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
    const resultRoomId = result.room_id ?? result.roomId;
    if (resultRoomId !== this.roomId || (result.room_id !== undefined && result.roomId !== undefined && result.room_id !== result.roomId)) {
      throw new Error("Group message response belongs to a different Rub Minds room");
    }
    // Validate all rows before the first provider effect. Do not partially
    // process a mixed-room batch returned by a faulty or compromised transport.
    if (result.messages.some(message => message && typeof message === "object" &&
      message.room_id !== undefined && message.room_id !== this.roomId)) {
      throw new Error("Cross-room message encountered in group message response");
    }

    let sent = 0;
    let processed = 0;
    for (const message of result.messages) {
      if (this.replies >= effectiveLimit || processed >= this.maxMessagesPerStep) break;
      if (!message || typeof message.id !== "string" || message.id.length < 1 || message.id.length > 200 ||
        typeof message.body !== "string" || !message.body.trim()) continue;
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

      if (message.body.length > this.maxMessageChars) {
        return {
          status: "message_too_large", sent, processed,
          messageId: message.id,
          reason: "Message exceeded the configured size limit; review or split it before processing.",
        };
      }

      processed++;
      let response;
      try {
        response = await this.adapter.ask(this.page, message.body, {
          messageId: message.id,
          senderKind: message.sender_kind,
          senderName: message.display_name ?? null,
        });
      } catch (error) {
        // A provider-side failure occurred before a response was returned, so
        // a later explicit step may safely retry this message.
        this.seen.delete(message.id);
        throw error;
      }
      if (typeof response !== "string" || !response.trim()) continue;

      try {
        // The transport should use source message IDs as idempotency keys and
        // explicitly acknowledge accepted delivery.
        const delivery = await this.sendMessage(response.trim(), message.id);
        // Supported transports return an explicit success flag/status or a
        // durable message row/ID (Supabase rows use id; agent_exchange returns
        // message_id). Undefined and false-like responses are not acknowledgements.
        const hasDurableMessageId = [delivery?.id, delivery?.message_id, delivery?.messageId]
          .some(value => typeof value === "string" && value.length > 0);
        if (!(delivery === true || delivery?.ok === true || delivery?.status === "sent" || hasDurableMessageId)) {
          return {
            status: "send_outcome_ambiguous", sent, processed,
            messageId: message.id,
            reason: "The transport did not confirm delivery. Verify the group before retrying.",
          };
        }
      } catch {
        // A send rejection can be ambiguous: the server may have accepted the
        // response before the connection failed. Keep the message ID in the
        // dedupe set and stop the loop for review rather than asking the
        // provider again or risking a duplicate reply.
        return {
          status: "send_outcome_ambiguous", sent, processed,
          messageId: message.id,
          reason: "Response delivery could not be confirmed. Verify the group before retrying.",
        };
      }
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
      while (this.running && !signal?.aborted && this.replies < this.maxReplies) {
        const outcome = await this.step({ approved, remainingReplies: this.maxReplies - this.replies });
        if (outcome.status === "browser_closed" || outcome.status === "limit_reached" || outcome.status === "seen_budget_reached" || outcome.status === "send_outcome_ambiguous" || outcome.status === "message_too_large") break;
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
