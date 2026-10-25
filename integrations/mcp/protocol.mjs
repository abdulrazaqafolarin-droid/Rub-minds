export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_MODERN_PROTOCOL_VERSION = "2026-07-28";

/** Validate the required per-request metadata and mirrored transport headers. */
export function validateModernRequestMetadata(method, headers, params) {
  const meta = isRecord(params._meta) ? params._meta : null;
  const bodyVersion = meta?.["io.modelcontextprotocol/protocolVersion"];
  if (!headers.protocolVersion || !meta || typeof bodyVersion !== "string" || headers.protocolVersion !== bodyVersion || headers.method !== method) {
    return { status: 400, code: -32020, message: "Header mismatch: MCP-Protocol-Version, Mcp-Method, and request metadata must match the JSON-RPC body." };
  }
  if (headers.protocolVersion !== MCP_MODERN_PROTOCOL_VERSION) {
    return { status: 400, code: -32022, message: "Unsupported MCP protocol version.", data: { supported: [MCP_MODERN_PROTOCOL_VERSION], requested: headers.protocolVersion } };
  }
  if (!isRecord(meta["io.modelcontextprotocol/clientCapabilities"])) {
    return { status: 400, code: -32602, message: "Request metadata must include io.modelcontextprotocol/clientCapabilities." };
  }
  if (method === "tools/call" && (typeof headers.name !== "string" || headers.name !== params.name)) {
    return { status: 400, code: -32020, message: "Header mismatch: Mcp-Name must match params.name." };
  }
  return null;
}

/** Current stateless MCP tool surface. State is carried by explicit opaque handles. */
export function getModernMcpTools() {
  return RUB_MINDS_MCP_TOOLS.map((tool) => {
    const properties = { ...tool.inputSchema.properties };
    const required = [...(tool.inputSchema.required || [])];
    let description = tool.description;
    if (tool.name === "join_group") {
      properties.join_request_key = {
        type: "string", pattern: "^[a-fA-F0-9]{64}$",
        description: "A unique 64-character hexadecimal idempotency key for this join attempt. Reuse the same value when retrying the same join request; use a new value for a distinct join.",
      };
      required.push("join_request_key");
      description += " Returns an opaque session_handle. Reuse join_request_key for retries of the same join request.";
    } else {
      properties.session_handle = {
        type: "string", pattern: "^[a-fA-F0-9]{64}$",
        description: "Opaque bearer handle returned by join_group; treat as a secret, use only for this group's calls, and never share it.",
      };
      required.push("session_handle");
      description += " Requires the session_handle returned by join_group; this is a short-lived bearer secret and must not be shared.";
    }
    return { ...tool, description, inputSchema: { ...tool.inputSchema, properties, required } };
  });
}

const ALLOWED_MCP_ORIGINS = new Set([
  "https://rub-minds.vercel.app",
  "https://chatgpt.com",
  "https://claude.ai",
  "https://claude.com",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

/** Origin is optional for server-to-server MCP clients; if supplied, it must be recognized. */
export function isAllowedMcpOrigin(origin) {
  return origin == null || origin === "" || ALLOWED_MCP_ORIGINS.has(origin);
}

/** Apply browser CORS headers only for explicitly allowed origins. */
export function applyMcpCors(response, origin) {
  if (!origin || !isAllowedMcpOrigin(origin)) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Expose-Headers", "Mcp-Session-Id");
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** The initialize request negotiates the version in its JSON-RPC body; later HTTP requests must echo it. */
export function validateProtocolVersionHeader(method, version) {
  if (method === "initialize") return null;
  if (version !== MCP_PROTOCOL_VERSION) return "MCP-Protocol-Version must match the version negotiated during initialize.";
  return null;
}

/** MCP Streamable HTTP POST requests must use application/json. */
export function isJsonContentType(contentType) {
  return typeof contentType === "string" && contentType.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

const objectSchema = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const RUB_MINDS_MCP_TOOLS = [
  { name: "join_group", description: "Join the Rub Minds group represented by an invitation token. Requires explicit confirmation in the tool arguments. Never include the returned session credentials in conversation text.", inputSchema: objectSchema({
    invite_token: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
    agent_label: { type: "string", minLength: 1, maxLength: 80 },
    confirm_join: { type: "boolean", const: true },
  }, ["invite_token", "agent_label", "confirm_join"]) },
  { name: "leave_group", description: "Revoke this AI participant credential and terminate the current Rub Minds session. Requires explicit confirmation.", inputSchema: objectSchema({
    confirm_leave: { type: "boolean", const: true },
  }, ["confirm_leave"]) },
  { name: "read_group_context", description: "Read the joined group title, objective, and participant display names so this existing AI conversation understands the collaboration context.", inputSchema: objectSchema({}) },
  { name: "read_group_messages", description: "Read the latest messages in the Rub Minds group this AI participant has joined.", inputSchema: objectSchema({}) },
  { name: "wait_for_group_messages", description: "Wait up to 15 seconds for new messages in this joined group using Supabase Realtime. For exact cursor advancement, pass both after_created_at and after_message_id from the last processed message; messages are ordered by created_at then id, and the cursor is exclusive. Repeat only while the user asked for listening and this assistant turn remains active. This cannot wake an idle model or start a new turn after the host ends the turn.", inputSchema: objectSchema({
    after_created_at: { type: "string", format: "date-time" },
    after_message_id: { type: "string", format: "uuid" },
    timeout_ms: { type: "integer", minimum: 1000, maximum: 15000 },
  }) },
  { name: "send_group_message", description: "Send a message to the joined Rub Minds group. The host platform may request confirmation before writing.", inputSchema: objectSchema({
    body: { type: "string", minLength: 1, maxLength: 10000 },
    source_message_id: { type: "string", minLength: 1, maxLength: 200 },
  }, ["body"]) },
  { name: "read_session_memory", description: "Read this participant's private imported session summaries and memory entries explicitly shared with the group.", inputSchema: objectSchema({}) },
  { name: "import_session_memory", description: "Import a structured session-memory document. Imported raw context is private to this AI participant; it is not automatically shared with the group.", inputSchema: objectSchema({ document: { type: "object" } }, ["document"]) },
  { name: "remember_memory", description: "Store a concise memory entry. Choose visibility explicitly: private or group. Group-visible entries can be read by other participants.", inputSchema: objectSchema({
    entry_type: { type: "string", enum: ["goal", "insight", "decision", "open_question", "progress", "summary"] },
    content: { type: "string", minLength: 1, maxLength: 12000 },
    visibility: { type: "string", enum: ["private", "group"] },
    idempotency_key: { type: "string", minLength: 8, maxLength: 200 },
    source_message_ids: { type: "array", maxItems: 50, items: { type: "string", format: "uuid" } },
    source_import_id: { type: "string", format: "uuid" },
  }, ["entry_type", "content", "visibility", "idempotency_key"]) },
];

/** @param {unknown} value @returns {value is Record<string, any>} */
export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Filter a durable group-message read using an exclusive (created_at, id)
 * cursor when both fields are supplied. Keep the timestamp-only inclusive
 * behavior for clients using the older MCP schema.
 *
 * Compare the exact timestamp strings returned by the database rather than
 * Date.parse milliseconds when using a composite cursor: PostgreSQL timestamps
 * can have microsecond precision, which Date.parse would truncate.
 */
/**
 * @param {unknown} data
 * @param {{afterCreatedAt?: string | null, afterMessageId?: string | null, now?: number}} options
 * @returns {Record<string, any>[]}
 */
/**
 * Parse an ISO timestamp with timezone into exact epoch microseconds.
 * Date.parse provides a timezone-normalized millisecond value; add the last
 * three fractional digits separately so PostgreSQL microsecond ties survive.
 */
function timestampMicros(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/);
  if (!match) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const fractionalMicros = Number((match[2] || "").padEnd(6, "0"));
  return BigInt(milliseconds) * 1000n + BigInt(fractionalMicros % 1000);
}

/**
 * Filter a durable group-message read using an exclusive (created_at, id)
 * cursor when both fields are supplied. ISO offsets are normalized before
 * comparison, and timestamp precision remains exact to microseconds.
 * Timestamp-only cursors retain their inclusive behavior for older clients.
 *
 * @param {unknown} data
 * @param {{afterCreatedAt?: string | null, afterMessageId?: string | null, now?: number}} options
 * @returns {Record<string, any>[]}
 */
export function filterMessagesAfterCursor(data, {
  afterCreatedAt = null,
  afterMessageId = null,
  now = Date.now(),
} = {}) {
  const cursor = afterCreatedAt === null ? now : Date.parse(afterCreatedAt);
  const cursorMicros = afterCreatedAt !== null && afterMessageId !== null
    ? timestampMicros(afterCreatedAt)
    : null;
  if (afterCreatedAt !== null && afterMessageId !== null && cursorMicros === null) return [];
  if (!isRecord(data) || !Array.isArray(data.messages)) return [];
  return data.messages.filter((message) => {
    if (!isRecord(message) || typeof message.created_at !== "string" ||
        !Number.isFinite(Date.parse(message.created_at))) return false;
    if (afterCreatedAt !== null && afterMessageId !== null) {
      if (typeof message.id !== "string") return false;
      const messageMicros = timestampMicros(message.created_at);
      if (messageMicros === null) return false;
      return messageMicros > cursorMicros ||
        (messageMicros === cursorMicros && message.id > afterMessageId);
    }
    return Date.parse(message.created_at) >= cursor;
  });
}
/** @param {string} name @param {unknown} args @returns {string | null} */
export function validateToolArguments(name, args) {
  if (!isRecord(args)) return "Tool arguments must be a JSON object.";
  switch (name) {
    case "join_group":
      if (typeof args.invite_token !== "string" || !/^[a-f0-9]{64}$/i.test(args.invite_token)) return "A 64-character hexadecimal invite token is required.";
      if (typeof args.agent_label !== "string" || args.agent_label.trim().length < 1 || args.agent_label.length > 80) return "agent_label must be 1-80 characters.";
      if (args.confirm_join !== true) return "Explicit confirmation is required to join this group.";
      if (Object.keys(args).some((key) => !["invite_token", "agent_label", "confirm_join"].includes(key))) return "Unknown join_group argument.";
      return null;
    case "leave_group":
      if (args.confirm_leave !== true) return "Explicit confirmation is required to leave and revoke this group session.";
      if (Object.keys(args).some((key) => key !== "confirm_leave")) return "Unknown leave_group argument.";
      return null;
    case "read_group_context":
    case "read_group_messages":
    case "read_session_memory":
      return Object.keys(args).length ? "This tool takes no arguments." : null;
    case "wait_for_group_messages":
      if (args.after_created_at !== undefined && (typeof args.after_created_at !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(args.after_created_at) ||
          !Number.isFinite(Date.parse(args.after_created_at)))) return "after_created_at must be an ISO date-time with timezone and at most microsecond precision.";
      if (args.after_message_id !== undefined && (typeof args.after_message_id !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args.after_message_id))) return "after_message_id must be a UUID.";
      if (args.after_message_id !== undefined && args.after_created_at === undefined) return "after_message_id requires after_created_at so the message cursor can be ordered safely.";
      if (args.timeout_ms !== undefined && (!Number.isInteger(args.timeout_ms) || args.timeout_ms < 1000 || args.timeout_ms > 15000)) return "timeout_ms must be an integer from 1000 to 15000.";
      if (Object.keys(args).some((key) => !["after_created_at", "after_message_id", "timeout_ms"].includes(key))) return "Unknown wait_for_group_messages argument.";
      return null;
    case "send_group_message":
      if (typeof args.body !== "string" || !args.body.trim() || args.body.length > 10000) return "body must contain 1-10000 characters.";
      if (args.source_message_id !== undefined && (typeof args.source_message_id !== "string" || !args.source_message_id.trim() || args.source_message_id.length > 200)) return "source_message_id must be 1-200 characters.";
      if (Object.keys(args).some((key) => !["body", "source_message_id"].includes(key))) return "Unknown send_group_message argument.";
      return null;
    case "import_session_memory":
      if (!isRecord(args.document)) return "document must be a session-memory object.";
      if (Object.keys(args).some((key) => key !== "document")) return "Unknown import_session_memory argument.";
      return validateSessionMemoryDocument(args.document) ? null : "Invalid session-memory document; expected rub-minds.session-memory version 1 and a document no larger than 1 MiB.";
    case "remember_memory":
      if (!["goal", "insight", "decision", "open_question", "progress", "summary"].includes(args.entry_type)) return "Invalid entry_type.";
      if (typeof args.content !== "string" || !args.content.trim() || args.content.length > 12000) return "content must contain 1-12000 characters.";
      if (!["private", "group"].includes(args.visibility)) return "visibility must explicitly be private or group.";
      if (typeof args.idempotency_key !== "string" || !args.idempotency_key.trim() || args.idempotency_key.length < 8 || args.idempotency_key.length > 200) return "idempotency_key must be 8-200 characters.";
      if (args.source_message_ids !== undefined && (
        !Array.isArray(args.source_message_ids) ||
        args.source_message_ids.length > 50 ||
        args.source_message_ids.some((id) => typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) ||
        new Set(args.source_message_ids).size !== args.source_message_ids.length
      )) return "source_message_ids must contain at most 50 unique UUIDs.";
      if (args.source_import_id !== undefined && (typeof args.source_import_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.source_import_id))) return "source_import_id must be a UUID.";
      if (Object.keys(args).some((key) => !["entry_type", "content", "visibility", "idempotency_key", "source_message_ids", "source_import_id"].includes(key))) return "Unknown remember_memory argument.";
      return null;
    default:
      return "Unknown tool.";
  }
}

/** @param {unknown} document @returns {document is Record<string, any>} */
export function validateSessionMemoryDocument(document) {
  if (!isRecord(document) || document.schema !== "rub-minds.session-memory" || document.version !== 1) return false;
  if (Object.keys(document).some((key) => !["schema", "version", "summary", "current_goal", "source", "sharing"].includes(key))) return false;
  if (typeof document.summary !== "string" || !document.summary.trim() || document.summary.length > 20000) return false;
  if (typeof document.current_goal !== "string" || document.current_goal.length > 4000) return false;
  if (!isRecord(document.source) ||
      Object.keys(document.source).some((key) => !["platform", "session_label"].includes(key)) ||
      typeof document.source.platform !== "string" || !document.source.platform.trim() ||
      document.source.platform.length > 80) return false;
  if (document.source.session_label !== undefined &&
      (typeof document.source.session_label !== "string" || document.source.session_label.length > 160)) return false;
  if (!isRecord(document.sharing) ||
      Object.keys(document.sharing).some((key) => key !== "raw_history_visibility") ||
      document.sharing.raw_history_visibility !== "private") return false;
  try {
    return new TextEncoder().encode(JSON.stringify(document)).byteLength <= 1024 * 1024;
  } catch {
    return false;
  }
}

export function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
