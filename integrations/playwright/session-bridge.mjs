import { compareMessageCursors, isValidMessageCursor } from "../mcp/protocol.mjs";

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

function assertDeliveryAccepted(result) {
  if (result === false) throw new Error("Rub Minds rejected group reply delivery");
  if (result && typeof result === "object" && (
    result.ok === false ||
    result.success === false ||
    result.delivered === false ||
    result.isError === true ||
    (result.error !== undefined && result.error !== null)
  )) {
    throw new Error("Rub Minds rejected group reply delivery");
  }
}

function waitForInterval(intervalMs, signal) {
  return new Promise(resolve => {
    let timer;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    if (signal?.aborted) {
      finish();
      return;
    }
    timer = setTimeout(finish, intervalMs);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export class PlaywrightSessionBridge {
  constructor({
    page,
    adapter,
    readMessages,
    sendMessage,
    participantId,
    intervalMs = 5000,
    maxReplies = 20,
    maxMessagesPerStep = 1,
    processExistingMessages = false,
    maxSeenMessageIds = 2000,
    stateStore = null,
  } = {}) {
    if (!page || typeof page.isClosed !== "function" || !adapter || typeof adapter.ask !== "function") {
      throw new TypeError("Playwright page and AI adapter.ask are required");
    }
    if (typeof readMessages !== "function" || typeof sendMessage !== "function") {
      throw new TypeError("Message transport functions required");
    }
    if (typeof participantId !== "string" || !participantId.trim()) {
      throw new TypeError("participantId is required to prevent the bridge from replying to itself");
    }
    participantId = participantId.trim();
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
    if (stateStore !== null && (
      !stateStore || typeof stateStore.load !== "function" || typeof stateStore.save !== "function"
    )) {
      throw new TypeError("stateStore must provide load() and save() methods");
    }

    Object.assign(this, {
      page, adapter, readMessages, sendMessage, participantId,
      intervalMs, maxReplies, maxMessagesPerStep, processExistingMessages, maxSeenMessageIds, stateStore,
    });
    this.running = false;
    this.runController = null;
    this.stepInProgress = false;
    this.initialized = false;
    this.durableStateLoaded = false;
    this.stateRevision = null;
    this.statePersistenceFailed = false;
    this.replies = 0;
    this.cursor = null;
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

  advanceCursor(message) {
    if (!isValidMessageCursor(message)) return false;
    const candidate = { id: message.id, created_at: message.created_at };
    if (!this.cursor || compareMessageCursors(candidate, this.cursor) > 0) {
      this.cursor = candidate;
      return true;
    }
    return false;
  }

  async restoreDurableState({ signal } = {}) {
    if (this.durableStateLoaded) {
      return {
        status: "loaded",
        hasResumeState: Boolean(this.cursor || this.pendingResponses.size || this.blockedMessage),
      };
    }
    if (!this.stateStore) {
      this.durableStateLoaded = true;
      return { status: "unconfigured", hasResumeState: false };
    }
    const state = await this.stateStore.load({ signal });
    if (!state || !Number.isSafeInteger(state.revision) || state.revision < 0) {
      throw new Error("Could not restore a valid durable bridge-state revision");
    }
    if (state.cursor !== null) {
      const cursor = state.cursor;
      if (!cursor || typeof cursor !== "object" ||
          !isValidMessageCursor({ id: cursor.after_message_id, created_at: cursor.after_created_at })) {
        throw new Error("Could not restore the durable composite message cursor");
      }
      this.cursor = { id: cursor.after_message_id, created_at: cursor.after_created_at };
    }
    if (state.pending_response !== null && state.blocked_message !== null) {
      throw new Error("Durable bridge state cannot contain both a pending response and a blocked-message marker");
    }
    if (state.pending_response !== null) {
      const pending = state.pending_response;
      if (!pending || typeof pending.source_message_id !== "string" ||
          typeof pending.message_created_at !== "string" || typeof pending.body !== "string") {
        throw new Error("Could not restore the durable pending response");
      }
      this.pendingResponses.set(pending.source_message_id, {
        body: pending.body,
        message: { id: pending.source_message_id, created_at: pending.message_created_at },
      });
    }
    if (state.blocked_message !== null) {
      const blocked = state.blocked_message;
      if (!blocked || typeof blocked.message_id !== "string" || typeof blocked.reason !== "string") {
        throw new Error("Could not restore the durable blocked-message marker");
      }
      this.blockedMessage = { messageId: blocked.message_id, reason: blocked.reason };
    }
    this.stateRevision = state.revision;
    this.durableStateLoaded = true;
    return {
      status: "loaded",
      hasResumeState: Boolean(this.cursor || this.pendingResponses.size || this.blockedMessage),
    };
  }

  async persistDurableState({ signal } = {}) {
    if (!this.stateStore) return { saved: true, revision: null };
    if (this.statePersistenceFailed) throw new Error("Durable bridge-state persistence previously failed; stopping safely");
    if (!this.durableStateLoaded || !Number.isSafeInteger(this.stateRevision) || this.stateRevision < 0) {
      throw new Error("Durable bridge state must be loaded before saving");
    }
    const pending = [...this.pendingResponses.entries()];
    if (pending.length > 1) throw new Error("Durable bridge state supports one pending response at a time");
    const [messageId, pendingRecord] = pending[0] || [];
    const snapshot = {
      expected_revision: this.stateRevision,
      cursor: this.cursor
        ? { after_created_at: this.cursor.created_at, after_message_id: this.cursor.id }
        : null,
      pending_response: pendingRecord
        ? {
            source_message_id: messageId,
            message_created_at: pendingRecord.message.created_at,
            body: pendingRecord.body,
          }
        : null,
      blocked_message: this.blockedMessage
        ? { message_id: this.blockedMessage.messageId, reason: this.blockedMessage.reason }
        : null,
    };
    try {
      const result = await this.stateStore.save(snapshot, { signal });
      if (!result || result.saved !== true || result.conflict !== false ||
          !Number.isSafeInteger(result.revision) || result.revision < 0) {
        throw new Error("Durable bridge-state revision conflict or invalid save acknowledgement");
      }
      this.stateRevision = result.revision;
      return result;
    } catch (error) {
      this.statePersistenceFailed = true;
      throw error;
    }
  }

  async advanceAndPersist(message, { signal } = {}) {
    const advanced = this.advanceCursor(message);
    if (advanced) await this.persistDurableState({ signal: signal?.aborted ? undefined : signal });
    return advanced;
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
    if (this.statePersistenceFailed) throw new Error("Durable bridge-state persistence previously failed; stopping safely");

    const restored = await this.restoreDurableState({ signal });
    if (signal?.aborted) return { status: "cancelled", baselineMessages: 0 };
    if (this.blockedMessage) {
      return {
        status: "blocked",
        baselineMessages: 0,
        blockedMessageId: this.blockedMessage.messageId,
        reason: this.blockedMessage.reason,
      };
    }
    if (restored.hasResumeState) {
      this.initialized = true;
      return { status: "ready", baselineMessages: 0, restored: true };
    }

    if (this.processExistingMessages) {
      // Explicit backlog processing starts before any real message, rather than
      // from a bounded latest-50 snapshot. Seed an epoch cursor when no cursor
      // was restored so subsequent immediate reads can page through the backlog.
      if (!this.cursor) {
        this.cursor = {
          created_at: "1970-01-01T00:00:00.000Z",
          id: "00000000-0000-1000-8000-000000000000",
        };
        await this.persistDurableState({ signal: signal?.aborted ? undefined : signal });
      }
      this.initialized = true;
      return { status: "ready", baselineMessages: 0, processExistingMessages: true };
    }

    // Baseline reads are separate from the per-step reply budget. Ask the
    // adapter for a sufficiently broad current snapshot so cursor advances to
    // the newest existing row even when maxMessagesPerStep is configured to 1.
    const result = await this.readMessages({
      signal,
      baseline: true,
      cursor: null,
      after_created_at: null,
      after_message_id: null,
      limit: 100,
    });
    if (signal?.aborted) return { status: "cancelled", baselineMessages: 0 };
    if (!result || !Array.isArray(result.messages)) {
      throw new Error("Invalid group message response while establishing startup baseline");
    }
    let baselineMessages = 0;
    for (const message of result.messages) {
      if (!message || typeof message.id !== "string" || !message.id) continue;
      this.markSeen(message.id);
      this.advanceCursor(message);
      baselineMessages++;
    }
    // Preserve a high-water cursor when a reader's startup snapshot is empty.
    // Otherwise the first new message would fall back to the legacy latest-50 read.
    const nextCursor = result.next_cursor;
    if (nextCursor && typeof nextCursor === "object" &&
        typeof nextCursor.after_created_at === "string" &&
        typeof nextCursor.after_message_id === "string") {
      this.advanceCursor({
        created_at: nextCursor.after_created_at,
        id: nextCursor.after_message_id,
      });
    }
    await this.persistDurableState({ signal: signal?.aborted ? undefined : signal });
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
    // A direct step() call can restore a blocked marker during initialize().
    // Recheck it here before any message read or provider interaction.
    if (this.blockedMessage) {
      return {
        status: "blocked",
        sent: 0,
        processed: 0,
        blockedMessageId: this.blockedMessage.messageId,
        reason: this.blockedMessage.reason,
      };
    }

    let sent = 0;
    let processed = 0;

    // Deliver completed replies before prompting the provider again. If a send
    // failed ambiguously, resend the same body with the same idempotency key.
    for (const [messageId, pending] of this.pendingResponses) {
      if (signal?.aborted) return { status: "cancelled", sent, processed };
      if (this.replies >= effectiveLimit || sent >= remainingReplies) break;
      try {
        const acknowledgement = await this.sendMessage(pending.body, messageId, { signal });
        assertDeliveryAccepted(acknowledgement);
      } catch (error) {
        if (sent > 0) return errorOutcome(error, sent, processed);
        throw error;
      }
      this.pendingResponses.delete(messageId);
      this.advanceCursor(pending.message);
      this.replies++;
      sent++;
      await this.persistDurableState({ signal: signal?.aborted ? undefined : signal });
    }
    if (this.replies >= effectiveLimit) return { status: "limit_reached", sent, processed };
    if (signal?.aborted) return { status: "cancelled", sent, processed };

    let result;
    try {
      const cursor = this.cursor
        ? { after_created_at: this.cursor.created_at, after_message_id: this.cursor.id }
        : null;
      result = await this.readMessages({
        signal,
        cursor,
        after_created_at: cursor?.after_created_at ?? null,
        after_message_id: cursor?.after_message_id ?? null,
        limit: this.maxMessagesPerStep,
      });
    } catch (error) {
      if (sent > 0) return errorOutcome(error, sent, processed);
      throw error;
    }
    if (!result || !Array.isArray(result.messages)) {
      const error = new Error("Invalid group message response");
      if (sent > 0) return errorOutcome(error, sent, processed);
      throw error;
    }

    const orderedMessages = [...result.messages].sort(compareMessageCursors);
    for (const message of orderedMessages) {
      if (signal?.aborted) return { status: "cancelled", sent, processed };
      if (this.replies >= effectiveLimit || processed >= this.maxMessagesPerStep) break;
      if (!message || typeof message.id !== "string" || !message.id) continue;
      if (this.pendingResponses.has(message.id)) continue;
      if (this.seen.has(message.id)) {
        await this.advanceAndPersist(message, { signal });
        continue;
      }

      // Mark every observed ID once, including ignored messages, so polling does
      // not repeatedly reconsider the same event.
      this.markSeen(message.id);
      if (typeof message.body !== "string") {
        await this.advanceAndPersist(message, { signal });
        continue;
      }
      if (this.participantId && message.sender_id === this.participantId) {
        await this.advanceAndPersist(message, { signal });
        continue;
      }
      if (message.sender_kind !== "human" && !AI_KINDS.has(message.sender_kind)) {
        await this.advanceAndPersist(message, { signal });
        continue;
      }

      // Optional server-supplied depth is respected when available. The server
      // remains responsible for global turn limits across multiple AI bridges.
      if (Number.isInteger(message.turn_depth) && message.turn_depth >= 8) {
        await this.advanceAndPersist(message, { signal });
        continue;
      }

      processed++;
      if (signal?.aborted) return { status: "cancelled", sent, processed };
      // Reserve this message using the durable revision counter before asking
      // the provider. Another process with the same old cursor must lose the CAS
      // and stop before invoking the provider a second time.
      this.blockedMessage = { messageId: message.id, reason: "provider_prompt_in_progress" };
      await this.persistDurableState({ signal });
      let response;
      try {
        response = await this.adapter.ask(this.page, message.body, {
          messageId: message.id,
          senderKind: message.sender_kind,
          senderName: message.display_name ?? message.sender_name ?? null,
          signal,
        });
      } catch (error) {
        if (error && typeof error === "object" && error.code === "RUB_MINDS_APPROVAL_DENIED") {
          // An explicit refusal is not an ambiguous provider call. Stop this
          // run without persisting a crash-recovery blocker; a later authorized
          // run may ask the owner again for the same unprocessed group message.
          this.blockedMessage = null;
          await this.persistDurableState({ signal: signal?.aborted ? undefined : signal });
          this.seen.delete(message.id);
          return {
            status: "blocked",
            sent,
            processed,
            blockedMessageId: message.id,
            reason: "approval_denied",
          };
        }
        if (isSafeToRetry(error)) {
          // The adapter guarantees that no prompt was submitted. Release the
          // durable claim even when cancellation occurred before the submit
          // action; only ambiguous post-submit cancellation must remain blocked.
          this.blockedMessage = null;
          await this.persistDurableState({ signal: signal?.aborted ? undefined : signal });
          this.seen.delete(message.id);
          if (signal?.aborted) return { status: "cancelled", sent, processed };
          if (sent > 0) return errorOutcome(error, sent, processed);
          throw error;
        }
        if (signal?.aborted) {
          this.blockedMessage = { messageId: message.id, reason: "provider_outcome_unknown_after_cancel" };
          await this.persistDurableState();
          return { status: "cancelled", sent, processed, blockedMessageId: message.id };
        }
        this.blockedMessage = { messageId: message.id, reason: "provider_outcome_unknown" };
        await this.persistDurableState({ signal });
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
        await this.persistDurableState({ signal: signal?.aborted ? undefined : signal });
        return {
          status: "blocked",
          sent,
          processed,
          blockedMessageId: message.id,
          reason: "provider_response_empty_or_incomplete",
        };
      }

      // Replace the in-progress claim with a durable completed answer before
      // delivery, allowing restart recovery without re-prompting the provider.
      this.blockedMessage = null;
      this.pendingResponses.set(message.id, {
        body: response.trim(),
        message: { id: message.id, created_at: message.created_at },
      });
      // Commit the completed answer before attempting network delivery. If the
      // process exits after this save, another instance can retry the same
      // source_message_id without invoking the provider a second time.
      await this.persistDurableState({ signal: signal?.aborted ? undefined : signal });
      if (signal?.aborted) return { status: "cancelled", sent, processed, pendingDelivery: true };

      try {
        const acknowledgement = await this.sendMessage(response.trim(), message.id, { signal });
        assertDeliveryAccepted(acknowledgement);
      } catch (error) {
        if (sent > 0) return errorOutcome(error, sent, processed);
        throw error;
      }
      this.pendingResponses.delete(message.id);
      this.advanceCursor(message);
      this.replies++;
      sent++;
      // Persist the acknowledged delivery and cursor together. If this save
      // fails, the durable row still contains the pending answer, which is
      // safe to retry because send_group_message deduplicates source_message_id.
      await this.persistDurableState({ signal: signal?.aborted ? undefined : signal });
    }

    return { status: "ok", sent, processed };
  }

  async run({ approved = false, signal } = {}) {
    if (!approved) throw new Error("Explicit approval required");
    if (this.running) throw new Error("Bridge already running");
    this.running = true;
    this.runController = new AbortController();
    const abort = () => this.runController?.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const runSignal = this.runController.signal;
    let finalStatus = "stopped";
    try {
      const initialization = await this.initialize({ approved, signal: runSignal });
      if (initialization.status === "browser_closed") {
        finalStatus = "browser_closed";
        return { status: finalStatus, replies: this.replies };
      }
      if (initialization.status === "cancelled" || runSignal.aborted) {
        finalStatus = "stopped";
        return { status: finalStatus, replies: this.replies };
      }
      while (this.running && !runSignal.aborted && this.replies < this.maxReplies) {
        const outcome = await this.step({
          approved,
          remainingReplies: this.maxReplies - this.replies,
          signal: runSignal,
        });
        if ([
          "browser_closed", "limit_reached", "blocked", "cancelled",
        ].includes(outcome.status)) {
          finalStatus = outcome.status;
          break;
        }
        await waitForInterval(this.intervalMs, runSignal);
      }
      if (runSignal.aborted) finalStatus = "stopped";
      else if (this.replies >= this.maxReplies) finalStatus = "limit_reached";
      return { status: finalStatus, replies: this.replies };
    } finally {
      signal?.removeEventListener("abort", abort);
      this.running = false;
      this.runController = null;
    }
  }

  stop() {
    this.running = false;
    this.runController?.abort();
  }
}
