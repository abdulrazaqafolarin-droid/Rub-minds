const REMOTE_PROTOCOL_VERSION = "2026-07-28";
const LOCAL_PROTOCOL_VERSION = "2025-06-18";
const MAX_MESSAGE_BYTES = 1_200_000;
const STAGING_MCP_HOST = "tzcuuynmviiuactafpld.supabase.co";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateMcpEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Set RUB_MINDS_MCP_ENDPOINT to the HTTPS Rub Minds MCP function URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== STAGING_MCP_HOST ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    url.pathname.replace(/\/$/, "") !== "/functions/v1/rub-minds-mcp" ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("RUB_MINDS_MCP_ENDPOINT must be the approved Rub Minds Staging MCP URL without credentials, query or fragment.");
  }
  return url.toString().replace(/\/$/, "");
}

function validateApiKey(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new TypeError("RUB_MINDS_MCP_API_KEY must be a public Supabase publishable/anon key.");
  }
  if (value.startsWith("sb_secret_")) {
    throw new TypeError("Secret Supabase API keys are not allowed in the terminal bridge.");
  }
  const parts = value.split(".");
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      if (payload?.role === "service_role") {
        throw new TypeError("The Supabase service-role key is forbidden in the terminal bridge.");
      }
    } catch (error) {
      if (error instanceof TypeError && /service-role key is forbidden/.test(error.message)) throw error;
      // Public key formats may change. A malformed token is rejected by the
      // upstream gateway, but a confirmed elevated role is always blocked.
    }
  }
  return value;
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/**
 * Bridges a local MCP stdio client to the hosted, stateless Rub Minds MCP API.
 * It does not store session handles or credentials: the calling MCP client
 * supplies the normal tool arguments, including session_handle, per request.
 */
export function createMcpStdioProxy({
  endpoint,
  apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
} = {}) {
  const target = validateMcpEndpoint(endpoint);
  const publicKey = validateApiKey(apiKey);
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) {
    throw new RangeError("MCP timeout must be between 1000 and 120000 milliseconds.");
  }
  let remoteId = 0;

  async function remoteRequest(method, params = {}) {
    const id = ++remoteId;
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "MCP-Protocol-Version": REMOTE_PROTOCOL_VERSION,
      "Mcp-Method": method,
    };
    if (method === "tools/call") headers["Mcp-Name"] = params.name;
    if (publicKey) headers.apikey = publicKey;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": REMOTE_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
    if (Buffer.byteLength(body, "utf8") > MAX_MESSAGE_BYTES) {
      throw new Error("MCP request exceeds the supported message size.");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    let response;
    let raw;
    try {
      response = await fetchImpl(target, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      });
      raw = await response.text();
    } catch {
      throw new Error("Could not reach or read the configured Rub Minds MCP endpoint. Check the network and endpoint, then retry.");
    } finally {
      clearTimeout(timer);
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_MESSAGE_BYTES) {
      throw new Error("Rub Minds MCP response exceeds the supported message size.");
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(response.ok
        ? "Rub Minds MCP returned an invalid JSON-RPC response."
        : "Rub Minds MCP rejected the request (HTTP " + response.status + ").");
    }
    if (!response.ok) {
      const message = typeof parsed?.error === "string" ? parsed.error : "HTTP " + response.status;
      throw new Error("Rub Minds MCP rejected the request: " + message.slice(0, 240));
    }
    if (!isRecord(parsed) || parsed.jsonrpc !== "2.0" || parsed.id !== id) {
      throw new Error("Rub Minds MCP returned a mismatched JSON-RPC response.");
    }
    if (isRecord(parsed.error)) {
      const message = typeof parsed.error.message === "string" ? parsed.error.message : "Upstream MCP error";
      const error = new Error(message.slice(0, 300));
      error.code = Number.isInteger(parsed.error.code) ? parsed.error.code : -32000;
      throw error;
    }
    if (!Object.hasOwn(parsed, "result")) {
      throw new Error("Rub Minds MCP response did not include a result.");
    }
    return parsed.result;
  }

  let discoveryPromise;
  async function discover() {
    if (!discoveryPromise) {
      discoveryPromise = remoteRequest("server/discover", {}).then((result) => {
        if (!isRecord(result) ||
            result.resultType !== "complete" ||
            !Array.isArray(result.supportedVersions) ||
            !result.supportedVersions.includes(REMOTE_PROTOCOL_VERSION) ||
            !isRecord(result.capabilities?.tools)) {
          throw new Error("The configured endpoint does not advertise the required Rub Minds MCP protocol.");
        }
        return result;
      }).catch((error) => {
        discoveryPromise = undefined;
        throw error;
      });
    }
    return discoveryPromise;
  }

  return Object.freeze({
    async handle(message) {
      if (!isRecord(message) || message.jsonrpc !== "2.0" ||
          typeof message.method !== "string") {
        return jsonRpcError(isRecord(message) ? message.id : null, -32600, "Invalid JSON-RPC request.");
      }
      const hasId = Object.hasOwn(message, "id");
      const id = message.id;
      if (!hasId) {
        // Notifications carry no response and must not trigger a remote write.
        return null;
      }
      if (!((typeof id === "string" && id.length > 0 && id.length <= 128) ||
          (typeof id === "number" && Number.isFinite(id)))) {
        return jsonRpcError(null, -32600, "Request id must be a string or number.");
      }
      const params = isRecord(message.params) ? message.params : {};

      try {
        if (message.method === "initialize") {
          const discovery = await discover();
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: LOCAL_PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: "rub-minds-terminal-bridge", version: "0.1.0" },
              instructions: typeof discovery.instructions === "string" ? discovery.instructions : "",
            },
          };
        }
        if (message.method === "ping") {
          return { jsonrpc: "2.0", id, result: {} };
        }
        if (message.method === "tools/list") {
          const result = await remoteRequest("tools/list", {});
          return { jsonrpc: "2.0", id, result };
        }
        if (message.method === "tools/call") {
          if (typeof params.name !== "string" || !params.name.trim() ||
              (params.arguments !== undefined && !isRecord(params.arguments))) {
            return jsonRpcError(id, -32602, "tools/call requires a tool name and an object of arguments.");
          }
          const result = await remoteRequest("tools/call", {
            name: params.name,
            arguments: params.arguments ?? {},
          });
          return { jsonrpc: "2.0", id, result };
        }
        return jsonRpcError(id, -32601, "Method not found.");
      } catch (error) {
        const code = Number.isInteger(error?.code) ? error.code : -32000;
        const messageText = error instanceof Error ? error.message : "Rub Minds MCP request failed.";
        return jsonRpcError(id, code, messageText.slice(0, 300));
      }
    },
  });
}

export const MCP_PROXY_LIMITS = Object.freeze({
  maxMessageBytes: MAX_MESSAGE_BYTES,
  remoteTimeoutMs: 30_000,
  localProtocolVersion: LOCAL_PROTOCOL_VERSION,
  remoteProtocolVersion: REMOTE_PROTOCOL_VERSION,
});
