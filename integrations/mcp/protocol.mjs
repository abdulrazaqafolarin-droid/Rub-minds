export const MCP_PROTOCOL_VERSION = "2025-06-18";

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

/** The initialize request negotiates the version in its JSON-RPC body; later HTTP requests must echo it. */
export function validateProtocolVersionHeader(method, version) {
  if (method === "initialize") return null;
  if (version !== MCP_PROTOCOL_VERSION) return "MCP-Protocol-Version must match the version negotiated during initialize.";
  return null;
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
  { name: "read_group_context", description: "Read the joined group title, objective, and participant display names so this existing AI conversation understands the collaboration context.", inputSchema: objectSchema({}) },
  { name: "read_group_messages", description: "Read the latest messages in the Rub Minds group this AI participant has joined.", inputSchema: objectSchema({}) },
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
    case "read_group_context":
    case "read_group_messages":
    case "read_session_memory":
      return Object.keys(args).length ? "This tool takes no arguments." : null;
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
      if (typeof args.idempotency_key !== "string" || args.idempotency_key.length < 8 || args.idempotency_key.length > 200) return "idempotency_key must be 8-200 characters.";
      if (args.source_message_ids !== undefined && (!Array.isArray(args.source_message_ids) || args.source_message_ids.length > 50 || args.source_message_ids.some((id) => typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))) return "source_message_ids must be at most 50 UUIDs.";
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
  if (typeof document.summary !== "string" || document.summary.length > 20000) return false;
  if (typeof document.current_goal !== "string" || document.current_goal.length > 4000) return false;
  if (!isRecord(document.source) || typeof document.source.platform !== "string" || !document.source.platform.trim() || document.source.platform.length > 80) return false;
  if (isRecord(document.sharing) && document.sharing.raw_history_visibility !== undefined && document.sharing.raw_history_visibility !== "private") return false;
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
