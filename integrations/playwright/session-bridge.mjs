/**
 * Playwright-backed Rub Minds session bridge foundation.
 *
 * A bridge transports group messages to an explicitly authorized browser AI
 * session. Provider-specific DOM adapters are deliberately separate: no
 * ChatGPT/Claude selector is guessed or hardcoded here.
 *
 * This is a bounded in-process loop. It is NOT hosted 24/7 infrastructure.
 */
export class PlaywrightSessionBridge {
  constructor({ page, adapter, readMessages, sendMessage, intervalMs = 5000, maxReplies = 20 }) {
    if (!page || !adapter || typeof adapter.ask !== "function") throw new TypeError("Playwright page and AI adapter.ask are required");
    if (typeof readMessages !== "function" || typeof sendMessage !== "function") throw new TypeError("Message transport functions required");
    if (!Number.isInteger(intervalMs) || intervalMs < 1000) throw new RangeError("intervalMs must be >= 1000");
    if (!Number.isInteger(maxReplies) || maxReplies < 1) throw new RangeError("maxReplies must be positive");
    Object.assign(this, { page, adapter, readMessages, sendMessage, intervalMs, maxReplies });
    this.running = false;
    this.replies = 0;
    this.seen = new Set();
  }

  async step({ approved = false } = {}) {
    if (!approved) throw new Error("Explicit approval required before accessing an AI browser session");
    if (this.replies >= this.maxReplies) return { status: "limit_reached" };
    if (this.page.isClosed()) return { status: "browser_closed" };
    const result = await this.readMessages();
    if (!result || !Array.isArray(result.messages)) throw new Error("Invalid group message response");
    let sent = 0;
    for (const message of result.messages) {
      if (this.replies >= this.maxReplies) break;
      if (!message || typeof message.id !== "string" || typeof message.body !== "string") continue;
      // Only human-origin messages; never create an agent-to-agent echo loop.
      if (message.sender_kind !== "human" || this.seen.has(message.id)) continue;
      this.seen.add(message.id);
      const response = await this.adapter.ask(this.page, message.body);
      if (typeof response !== "string" || !response.trim()) continue;
      await this.sendMessage(response.trim(), message.id);
      this.replies++;
      sent++;
    }
    return { status: "ok", sent };
  }

  async run({ approved = false, signal } = {}) {
    if (!approved) throw new Error("Explicit approval required");
    if (this.running) throw new Error("Bridge already running");
    this.running = true;
    try {
      while (this.running && !signal?.aborted && this.replies < this.maxReplies) {
        const outcome = await this.step({ approved });
        if (outcome.status === "browser_closed") break;
        await new Promise(resolve => setTimeout(resolve, this.intervalMs));
      }
    } finally {
      this.running = false;
    }
  }

  stop() { this.running = false; }
}
