/**
 * Supabase Realtime wake source for a live, authorized original-session runner.
 *
 * Subscribes only to INSERT events for one room. It does not read message
 * contents or send provider prompts; the existing bridge performs a durable
 * message read after receiving a wake signal. Periodic timeout heartbeats
 * recover from dropped notifications. The caller owns the Supabase client and
 * must enforce room-level authorization through its existing RLS/session.
 */
export class SupabaseRealtimeWakeSource {
  constructor({ client, roomId, maxQueuedWakes = 1, channelName } = {}) {
    if (!client || typeof client.channel !== "function") throw new TypeError("Supabase client.channel is required");
    if (typeof roomId !== "string" || !roomId.trim()) throw new TypeError("roomId is required");
    if (!Number.isInteger(maxQueuedWakes) || maxQueuedWakes < 1 || maxQueuedWakes > 100) {
      throw new RangeError("maxQueuedWakes must be between 1 and 100");
    }
    this.client = client;
    this.roomId = roomId;
    this.maxQueuedWakes = maxQueuedWakes;
    this.channelName = channelName ?? `rub-minds-wake-${roomId}`;
    this.queue = [];
    this.waiters = [];
    this.closed = false;
    this.channel = null;
  }

  async start() {
    if (this.closed) throw new Error("Wake source is closed");
    if (this.channel) return;
    this.channel = this.client.channel(this.channelName);
    this.channel.on("postgres_changes", {
      event: "INSERT",
      schema: "public",
      table: "messages",
      filter: `room_id=eq.${this.roomId}`,
    }, payload => {
      if (this.closed || payload?.new?.room_id !== this.roomId) return;
      const waiter = this.waiters.shift();
      if (waiter) waiter.finish({ status: "wake" });
      else if (this.queue.length < this.maxQueuedWakes) this.queue.push({ status: "wake" });
    });
    const channel = this.channel;
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      channel.subscribe(status => {
        if (status === "SUBSCRIBED") finish(resolve);
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          finish(reject, new Error(`Supabase Realtime subscription failed: ${status}`));
        }
      });
    }).catch(async error => {
      // Failed subscription attempts must not leave a stale channel behind.
      this.channel = null;
      if (typeof this.client.removeChannel === "function") {
        try {
          await this.client.removeChannel(channel);
        } catch {
          // Preserve the original subscription error; callers can retry with a new source.
        }
      }
      throw error;
    });
  }

  async waitForWake({ signal, timeoutMs = 15000 } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new RangeError("timeoutMs must be a positive integer");
    if (this.closed) return { status: "closed" };
    if (signal?.aborted) return { status: "closed" };
    if (this.queue.length) return this.queue.shift();

    return new Promise((resolve, reject) => {
      let settled = false;
      let timeout;
      const waiter = {
        finish: value => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          signal?.removeEventListener("abort", onAbort);
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          resolve(value);
        },
      };
      const onAbort = () => waiter.finish({ status: "closed" });
      this.waiters.push(waiter);
      timeout = setTimeout(() => waiter.finish({ status: "timeout" }), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of [...this.waiters]) waiter.finish({ status: "closed" });
    this.queue.length = 0;
    const channel = this.channel;
    this.channel = null;
    if (channel && typeof this.client.removeChannel === "function") await this.client.removeChannel(channel);
  }
}
