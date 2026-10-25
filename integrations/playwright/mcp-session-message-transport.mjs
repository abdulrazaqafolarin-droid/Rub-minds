/**
 * HTTP transport adapter for the hosted Rub Minds MCP message tools.
 *
 * Pass createBridgeAdapters() into PlaywrightSessionBridge. It sends only the
 * scoped Rub Minds session handle in the JSON-RPC tool arguments. It never
 * reads provider cookies, browser storage, or model-provider credentials.
 */
const SESSION_HANDLE_RE = /^[0-9a-f]{64}$/i;
const DEFAULT_PROTOCOL_VERSION = "2026-07-28";
const EMPTY_ROOM_CURSOR = Object.freeze({
  after_created_at: "1970-01-01T00:00:00.000Z",
  after_message_id: "00000000-0000-1000-8000-000000000000",
});
const MESSAGE_TOOL_NAMES = new Set([
  "read_group_messages",
  "wait_for_group_messages",
  "send_group_message",
  "load_original_session_bridge_state",
  "save_original_session_bridge_state",
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

function validateEndpoint(value) {
  if (typeof value !== "string" || value.length > 2048) {
    throw new TypeError("endpoint must be a valid HTTP(S) URL");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("endpoint must be a valid HTTP(S) URL");
  }
  const localHost = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localHost)) {
    throw new TypeError("endpoint must use HTTPS, except for loopback development");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("endpoint must not contain credentials, query parameters, or fragments");
  }
  return url.toString();
}

function extractStructuredContent(payload, requestId, toolName) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      payload.jsonrpc !== "2.0" || payload.id !== requestId) {
    throw new Error("Rub Minds MCP returned an invalid JSON-RPC response");
  }
  if (payload.error || !payload.result || typeof payload.result !== "object" || Array.isArray(payload.result)) {
    throw new Error("Rub Minds MCP " + toolName + " call failed");
  }
  if (payload.result.isError === true) {
    throw new Error("Rub Minds MCP " + toolName + " tool returned an error");
  }
  const data = payload.result.structuredContent;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Rub Minds MCP " + toolName + " returned no structured content");
  }
  return data;
}

export class McpSessionMessageTransport {
  constructor({
    endpoint,
    sessionHandle,
    fetchImpl = globalThis.fetch,
    protocolVersion = DEFAULT_PROTOCOL_VERSION,
    waitTimeoutMs = 10000,
    requestTimeoutMs = 20000,
  } = {}) {
    this.endpoint = validateEndpoint(endpoint);
    if (typeof sessionHandle !== "string" || !SESSION_HANDLE_RE.test(sessionHandle)) {
      throw new TypeError("sessionHandle must be a 64-character hexadecimal Rub Minds session handle");
    }
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
    if (typeof protocolVersion !== "string" || !protocolVersion.trim() || protocolVersion.length > 80) {
      throw new TypeError("protocolVersion must be a non-empty version string");
    }
    if (!Number.isInteger(waitTimeoutMs) || waitTimeoutMs < 1000 || waitTimeoutMs > 15000) {
      throw new RangeError("waitTimeoutMs must be an integer from 1000 to 15000");
    }
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < waitTimeoutMs + 1000 || requestTimeoutMs > 60000) {
      throw new RangeError("requestTimeoutMs must be at least waitTimeoutMs + 1000 and at most 60000");
    }
    this.sessionHandle = sessionHandle;
    this.fetchImpl = fetchImpl;
    this.protocolVersion = protocolVersion;
    this.waitTimeoutMs = waitTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.nextRequestId = 1;
  }

  async callTool(name, args = {}, { signal } = {}) {
    if (typeof name !== "string" || !MESSAGE_TOOL_NAMES.has(name)) {
      throw new TypeError("this transport only supports Rub Minds group-message and bridge-state tools");
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new TypeError("tool arguments must be an object");
    if (signal?.aborted) throw new Error("Rub Minds MCP call aborted");

    const requestId = this.nextRequestId++;
    if (!Number.isSafeInteger(this.nextRequestId)) this.nextRequestId = 1;
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const body = {
      jsonrpc: "2.0",
      id: requestId,
      method: "tools/call",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": this.protocolVersion,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
        name,
        arguments: { ...args, session_handle: this.sessionHandle },
      },
    };
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json, text/event-stream",
          "MCP-Protocol-Version": this.protocolVersion,
          "Mcp-Method": "tools/call",
          "Mcp-Name": name,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response || typeof response.ok !== "boolean" || typeof response.json !== "function") {
        throw new Error("Rub Minds MCP returned an invalid HTTP response");
      }
      if (!response.ok) throw new Error("Rub Minds MCP HTTP " + response.status);
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error("Rub Minds MCP returned invalid JSON");
      }
      return extractStructuredContent(payload, requestId, name);
    } catch (error) {
      if (signal?.aborted) throw new Error("Rub Minds MCP call aborted");
      if (controller.signal.aborted) throw new Error("Rub Minds MCP request timed out");
      if (error instanceof Error) throw error;
      throw new Error("Rub Minds MCP request failed");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  async readMessages({
    signal,
    cursor = null,
    after_created_at = null,
    after_message_id = null,
    limit = 100,
    baseline = false,
  } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("limit must be an integer from 1 to 100");
    }
    const cursorCreatedAt = after_created_at ?? cursor?.after_created_at ?? null;
    const cursorMessageId = after_message_id ?? cursor?.after_message_id ?? null;
    if (!baseline && (cursorCreatedAt !== null || cursorMessageId !== null)) {
      if (typeof cursorCreatedAt !== "string" || typeof cursorMessageId !== "string") {
        throw new TypeError("both composite cursor fields are required");
      }
      const result = await this.callTool("read_group_messages", {
        after_created_at: cursorCreatedAt,
        after_message_id: cursorMessageId,
        limit,
      }, { signal });
      if (!Array.isArray(result.messages)) throw new Error("Rub Minds MCP cursor read returned no message list");
      return result;
    }

    // The first read is a bounded current snapshot. Later reads use the same
    // read_group_messages tool with its composite cursor for immediate paging.
    const result = await this.callTool("read_group_messages", {}, { signal });
    if (!Array.isArray(result.messages)) throw new Error("Rub Minds MCP baseline read returned no message list");
    if (result.messages.length === 0 && !result.next_cursor) {
      return { ...result, next_cursor: { ...EMPTY_ROOM_CURSOR } };
    }
    return result;
  }

  async loadBridgeState({ signal } = {}) {
    const state = await this.callTool("load_original_session_bridge_state", {}, { signal });
    if (!Number.isSafeInteger(state.revision) || state.revision < 0) {
      throw new Error("Rub Minds bridge state has an invalid revision");
    }
    if (state.cursor !== null) {
      if (!state.cursor || !UUID_RE.test(state.cursor.after_message_id || "") ||
          typeof state.cursor.after_created_at !== "string" ||
          !TIMESTAMP_RE.test(state.cursor.after_created_at) ||
          !Number.isFinite(Date.parse(state.cursor.after_created_at))) {
        throw new Error("Rub Minds bridge state has an invalid composite cursor");
      }
    }
    if (state.pending_response !== null) {
      const pending = state.pending_response;
      if (!pending || !UUID_RE.test(pending.source_message_id || "") ||
          typeof pending.message_created_at !== "string" ||
          !TIMESTAMP_RE.test(pending.message_created_at) ||
          !Number.isFinite(Date.parse(pending.message_created_at)) ||
          typeof pending.body !== "string" || !pending.body.trim() || pending.body.length > 10000) {
        throw new Error("Rub Minds bridge state has an invalid pending response");
      }
    }
    if (state.blocked_message !== null) {
      const blocked = state.blocked_message;
      if (!blocked || !UUID_RE.test(blocked.message_id || "") ||
          typeof blocked.reason !== "string" || !blocked.reason.trim() || blocked.reason.length > 200) {
        throw new Error("Rub Minds bridge state has an invalid blocked-message marker");
      }
    }
    return state;
  }

  async saveBridgeState(snapshot, { signal } = {}) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) ||
        !Number.isSafeInteger(snapshot.expected_revision) || snapshot.expected_revision < 0) {
      throw new TypeError("bridge state snapshot and expected revision are required");
    }
    const cursor = snapshot.cursor ?? null;
    const pending = snapshot.pending_response ?? null;
    const blocked = snapshot.blocked_message ?? null;
    if (cursor !== null && (!UUID_RE.test(cursor.after_message_id || "") ||
        typeof cursor.after_created_at !== "string" ||
        !TIMESTAMP_RE.test(cursor.after_created_at) ||
        !Number.isFinite(Date.parse(cursor.after_created_at)))) {
      throw new TypeError("bridge state cursor is invalid");
    }
    if (pending !== null && (!UUID_RE.test(pending.source_message_id || "") ||
        typeof pending.message_created_at !== "string" ||
        !TIMESTAMP_RE.test(pending.message_created_at) ||
        !Number.isFinite(Date.parse(pending.message_created_at)) ||
        typeof pending.body !== "string" || !pending.body.trim() || pending.body.length > 10000)) {
      throw new TypeError("bridge state pending response is invalid");
    }
    if (blocked !== null && (!UUID_RE.test(blocked.message_id || "") ||
        typeof blocked.reason !== "string" || !blocked.reason.trim() || blocked.reason.length > 200)) {
      throw new TypeError("bridge state blocked marker is invalid");
    }
    const result = await this.callTool("save_original_session_bridge_state", {
      expected_revision: snapshot.expected_revision,
      cursor_created_at: cursor?.after_created_at ?? null,
      cursor_message_id: cursor?.after_message_id ?? null,
      pending_message_id: pending?.source_message_id ?? null,
      pending_message_created_at: pending?.message_created_at ?? null,
      pending_response: pending?.body ?? null,
      blocked_message_id: blocked?.message_id ?? null,
      blocked_reason: blocked?.reason ?? null,
    }, { signal });
    if (result.saved === false && result.conflict === true) return result;
    if (result.saved !== true || result.conflict !== false ||
        !Number.isSafeInteger(result.revision) || result.revision < 0) {
      throw new Error("Rub Minds bridge state save returned an invalid acknowledgement");
    }
    return result;
  }

  async waitForWake({ signal, timeoutMs = this.waitTimeoutMs, cursor = null } = {}) {
    const requestedTimeout = Number.isInteger(timeoutMs) ? timeoutMs : this.waitTimeoutMs;
    const boundedTimeout = Math.max(1000, Math.min(15000, this.waitTimeoutMs, requestedTimeout));
    const afterCreatedAt = cursor?.after_created_at ?? cursor?.created_at ?? null;
    const afterMessageId = cursor?.after_message_id ?? cursor?.id ?? null;
    if ((afterCreatedAt === null) !== (afterMessageId === null)) {
      throw new TypeError("wake cursor requires both timestamp and message ID");
    }
    const args = { timeout_ms: boundedTimeout, limit: 100 };
    if (afterCreatedAt !== null) {
      if (typeof afterCreatedAt !== "string" || typeof afterMessageId !== "string") {
        throw new TypeError("wake cursor timestamp and message ID must be strings");
      }
      args.after_created_at = afterCreatedAt;
      args.after_message_id = afterMessageId;
    }
    const result = await this.callTool("wait_for_group_messages", args, { signal });
    if (!Array.isArray(result.messages)) {
      throw new Error("Rub Minds MCP wake wait returned no message list");
    }
    const delivery = typeof result.delivery === "string" ? result.delivery : "unknown";
    if (result.timed_out === true || result.messages.length === 0) {
      return { status: "timeout", delivery, messageCount: 0 };
    }
    return { status: "wake", delivery, messageCount: result.messages.length };
  }

  createWakeSource() {
    return {
      start: async () => ({ status: "ready" }),
      waitForWake: this.waitForWake.bind(this),
      close: async () => {},
    };
  }

  async sendMessage(body, sourceMessageId, { signal } = {}) {
    if (typeof body !== "string" || !body.trim() || body.length > 10000) {
      throw new TypeError("body must contain 1-10000 characters");
    }
    if (typeof sourceMessageId !== "string" || !sourceMessageId.trim() || sourceMessageId.length > 200) {
      throw new TypeError("sourceMessageId must contain 1-200 characters for idempotent delivery");
    }
    return await this.callTool("send_group_message", {
      body,
      source_message_id: sourceMessageId,
    }, { signal });
  }

  createBridgeAdapters() {
    return {
      readMessages: this.readMessages.bind(this),
      sendMessage: this.sendMessage.bind(this),
    };
  }
}
