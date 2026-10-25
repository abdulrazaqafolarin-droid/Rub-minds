/**
 * HTTP transport adapter for the hosted Rub Minds MCP message tools.
 *
 * Pass createBridgeAdapters() into PlaywrightSessionBridge. It sends only the
 * scoped Rub Minds session handle in the JSON-RPC tool arguments. It never
 * reads provider cookies, browser storage, or model-provider credentials.
 */
const SESSION_HANDLE_RE = /^[0-9a-f]{64}$/i;
const DEFAULT_PROTOCOL_VERSION = "2026-07-28";

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
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.id !== requestId) {
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
    waitTimeoutMs = 1000,
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
    if (typeof name !== "string" || !name.trim()) throw new TypeError("tool name is required");
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
      const result = await this.callTool("wait_for_group_messages", {
        after_created_at: cursorCreatedAt,
        after_message_id: cursorMessageId,
        timeout_ms: this.waitTimeoutMs,
        limit,
      }, { signal });
      if (!Array.isArray(result.messages)) throw new Error("Rub Minds MCP cursor read returned no message list");
      return result;
    }

    // The legacy read tool returns a bounded current snapshot. The bridge uses
    // this once for startup baselining and then advances with the cursor tool.
    const result = await this.callTool("read_group_messages", {}, { signal });
    if (!Array.isArray(result.messages)) throw new Error("Rub Minds MCP baseline read returned no message list");
    return result;
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
