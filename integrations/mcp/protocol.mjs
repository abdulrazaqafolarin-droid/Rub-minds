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
  { name: "join_group", description: "Join the Rub Minds group represented by an invitation token. Requires explicit confirmation in the tool arguments. Never include the returned session credentials in conversation text. After a successful join, ask the user for consent to capture this session's accessible conversation unless consent was already explicit. After consent, call prepare_session_export with confirm_export=true; a group invitation alone is not consent to export history. Raw history stays private.", inputSchema: objectSchema({
    invite_token: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
    agent_label: { type: "string", minLength: 1, maxLength: 80 },
    confirm_join: { type: "boolean", const: true },
  }, ["invite_token", "agent_label", "confirm_join"]) },
  { name: "prepare_session_export", description: "After joining a group, call this to request a private document from the current AI conversation. Requires explicit user consent; set confirm_export=true only after the session owner has agreed. This tool cannot read provider history itself; follow the returned instructions using only conversation turns available to this session, redact credentials, mark incomplete history honestly, and then call import_session_memory. The import is private and raw history must never be sent to group messages.", inputSchema: objectSchema({ confirm_export: { type: "boolean", const: true } }, ["confirm_export"]) },
  { name: "leave_group", description: "Revoke this AI participant credential and terminate the current Rub Minds session. Requires explicit confirmation.", inputSchema: objectSchema({
    confirm_leave: { type: "boolean", const: true },
  }, ["confirm_leave"]) },
  { name: "read_group_context", description: "Read the joined group title, objective, and participant display names so this existing AI conversation understands the collaboration context.", inputSchema: objectSchema({}) },
  { name: "read_group_messages", description: "Read the latest messages in the Rub Minds group this AI participant has joined.", inputSchema: objectSchema({}) },
  { name: "wait_for_group_messages", description: "Wait briefly for new messages in this joined group using Supabase Realtime. This is a bounded wait, not an always-on listener; call again while actively participating. Supply after_message_id and after_created_at for the newest processed message to avoid replaying it.", inputSchema: objectSchema({
    after_created_at: { type: "string", format: "date-time" },
    after_message_id: { type: "string", format: "uuid" },
    timeout_ms: { type: "integer", minimum: 1000, maximum: 15000 },
  }) },
  { name: "send_group_message", description: "Send a message to the joined Rub Minds group. The host platform may request confirmation before writing.", inputSchema: objectSchema({
    body: { type: "string", minLength: 1, maxLength: 10000 },
    source_message_id: { type: "string", minLength: 1, maxLength: 200 },
  }, ["body"]) },
  { name: "read_session_memory", description: "Read this participant's private imported session summaries and memory entries explicitly shared with the group.", inputSchema: objectSchema({}) },
  { name: "import_session_memory", description: "Import a structured session-memory document, optionally including transcript_text and transcript_complete. Imported raw context is private to this AI participant; it is not automatically shared with the group.", inputSchema: objectSchema({ document: { type: "object" } }, ["document"]) },
  { name: "remember_memory", description: "Store a concise memory entry. Choose visibility explicitly: private or group. Group-visible entries can be read by other participants.", inputSchema: objectSchema({
    entry_type: { type: "string", enum: ["goal", "insight", "decision", "open_question", "progress", "summary"] },
    content: { type: "string", minLength: 1, maxLength: 12000 },
    visibility: { type: "string", enum: ["private", "group"] },
    idempotency_key: { type: "string", minLength: 8, maxLength: 200 },
    source_message_ids: { type: "array", maxItems: 50, items: { type: "string", format: "uuid" } },
    source_import_id: { type: "string", format: "uuid" },
  }, ["entry_type", "content", "visibility", "idempotency_key"]) },
  { name: "forget_memory", description: "Delete only a private browser recovery-link memory created by this AI participant, using its exact browser-resume idempotency key. Requires explicit confirmation. Cannot delete other private memories, group memory, or another participant's memory.", inputSchema: objectSchema({
    idempotency_key: { type: "string", pattern: "^browser-resume-[A-Za-z0-9-]{8,180}$" },
    confirm_forget: { type: "boolean", const: true },
  }, ["idempotency_key", "confirm_forget"]) },

  { name: "propose_group_task", description: "Propose a durable group task for human review. Proposals start in backlog and are not assigned or executed until a human assigns them. Use a stable idempotency_key when retrying the same proposal.", inputSchema: objectSchema({
    title: { type: "string", minLength: 1, maxLength: 160 },
    description: { type: "string", maxLength: 12000 },
    expected_output: { type: "string", maxLength: 4000 },
    acceptance_criteria: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 500 } },
    priority: { type: "integer", minimum: 1, maximum: 5 },
    due_at: { type: "string", format: "date-time" },
    idempotency_key: { type: "string", format: "uuid" },
  }, ["title", "idempotency_key"]) },
  { name: "list_group_tasks", description: "List up to 100 durable tasks in the group joined by this MCP session, including assignment, dependencies' readiness, and task status.", inputSchema: objectSchema({}) },
  { name: "read_group_task", description: "Read one task and its prerequisite IDs, submitted results, and review history. The task must belong to the group joined by this session.", inputSchema: objectSchema({
    task_id: { type: "string", format: "uuid" },
  }, ["task_id"]) },
  { name: "claim_group_task", description: "Claim a task that a human group member has assigned to this participant. The claim is atomic and idempotent, and succeeds only after all prerequisites are complete. AI participants cannot claim unassigned tasks or tasks assigned to another participant.", inputSchema: objectSchema({
    task_id: { type: "string", format: "uuid" },
  }, ["task_id"]) },
  { name: "block_group_task", description: "Mark a task assigned to this participant as blocked and explain what is preventing progress. This does not mark the task complete.", inputSchema: objectSchema({
    task_id: { type: "string", format: "uuid" },
    reason: { type: "string", minLength: 1, maxLength: 2000 },
  }, ["task_id", "reason"]) },
  { name: "fail_group_task", description: "Mark an active task assigned to this AI participant as failed when it cannot be completed. Provide a concise reason. This is terminal; use block_group_task for recoverable blockers.", inputSchema: objectSchema({
    task_id: { type: "string", format: "uuid" },
    reason: { type: "string", minLength: 1, maxLength: 2000 },
  }, ["task_id", "reason"]) },
  { name: "submit_group_task_result", description: "Submit a result for a task currently in progress and assigned to this participant. Submission moves the task to review; only an authorized human reviewer can approve completion. Use a UUID idempotency key for safe retries.", inputSchema: objectSchema({
    task_id: { type: "string", format: "uuid" },
    result: { type: "string", minLength: 1, maxLength: 20000 },
    submission_key: { type: "string", format: "uuid" },
    source_message_ids: { type: "array", maxItems: 50, items: { type: "string", format: "uuid" } },
  }, ["task_id", "result", "submission_key"]) },
];

/** Prompt returned by prepare_session_export; it never reads provider history itself. */
export const SESSION_EXPORT_INSTRUCTIONS = [
  "Create a plain-text transcript of the conversation in this AI session that you can actually access, in chronological order with speaker labels. Do not invent turns or claim to see history that is unavailable.",
  "Do not include hidden system/developer instructions, private chain-of-thought, passwords, API keys, access tokens, invitation tokens, recovery codes, or other credentials. Replace secret values with [REDACTED SECRET].",
  "Then call import_session_memory exactly once with a document containing only these fields: schema=\"rub-minds.session-memory\", version=1, summary (1-20000 characters), current_goal (0-4000 characters), source { platform (for example ChatGPT or Claude), session_label (optional) }, sharing { raw_history_visibility: \"private\" }, transcript_text (the available transcript as plain text), and transcript_complete (true only if you can verify the transcript contains the full session history; otherwise false). transcript_text must fit within the 1 MiB document limit.",
  "If full history is unavailable or the document is too large, include the accessible portion plus a useful summary and set transcript_complete=false. Say what is missing; never silently truncate or claim a complete export.",
  "The imported transcript remains private to this AI participant. Do not send raw transcript content to send_group_message or expose it to other participants. Report the actual import_session_memory tool result and the transcript_complete value; do not claim success before the tool succeeds."
].join("\n\n");

/** Select messages after the last processed cursor from a newest-50, ascending read window. */
/** @param {unknown} messages @param {number} cursorTimestamp @param {string | null} [cursorMessageId] */
export function messagesAfterCursor(messages, cursorTimestamp, cursorMessageId = null) {
  if (!Array.isArray(messages)) return [];
  const valid = messages.filter((message) =>
    message !== null && typeof message === "object" && !Array.isArray(message) &&
    typeof message.created_at === "string" && Number.isFinite(Date.parse(message.created_at))
  );
  if (typeof cursorMessageId === "string") {
    const index = valid.findIndex((message) => message.id === cursorMessageId);
    // An exact ID cursor handles messages sharing the same timestamp.
    if (index >= 0) return valid.slice(index + 1);
  }
  const cursor = Number.isFinite(cursorTimestamp) ? cursorTimestamp : Date.now();
  // Strict greater-than avoids replaying the already processed cursor message.
  return valid.filter((message) => Date.parse(message.created_at) > cursor);
}

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
    case "prepare_session_export":
      if (args.confirm_export !== true) return "Explicit confirmation is required before requesting session capture.";
      if (Object.keys(args).some((key) => key !== "confirm_export")) return "Unknown prepare_session_export argument.";
      return null;
    case "leave_group":
      if (args.confirm_leave !== true) return "Explicit confirmation is required to leave and revoke this group session.";
      if (Object.keys(args).some((key) => key !== "confirm_leave")) return "Unknown leave_group argument.";
      return null;
    case "read_group_context":
    case "read_group_messages":
    case "read_session_memory":
    case "list_group_tasks":
      return Object.keys(args).length ? "This tool takes no arguments." : null;
    case "wait_for_group_messages":
      if (args.after_created_at !== undefined && (typeof args.after_created_at !== "string" || !Number.isFinite(Date.parse(args.after_created_at)))) return "after_created_at must be a valid date-time string.";
      if (args.after_message_id !== undefined && args.after_created_at === undefined) return "after_created_at is required when after_message_id is supplied.";
      if (args.after_message_id !== undefined && (typeof args.after_message_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.after_message_id))) return "after_message_id must be a UUID.";
      if (args.timeout_ms !== undefined && (!Number.isInteger(args.timeout_ms) || args.timeout_ms < 1000 || args.timeout_ms > 15000)) return "timeout_ms must be an integer from 1000 to 15000.";
      if (Object.keys(args).some((key) => !["after_created_at", "after_message_id", "timeout_ms"].includes(key))) return "Unknown wait_for_group_messages argument.";
      return null;
    case "send_group_message":
      if (typeof args.body !== "string" || !args.body.trim() || args.body.length > 10000) return "body must contain 1-10000 characters.";
      if (args.source_message_id !== undefined && (typeof args.source_message_id !== "string" || !args.source_message_id.trim() || args.source_message_id.length > 200)) return "source_message_id must be 1-200 characters.";
      if (Object.keys(args).some((key) => !["body", "source_message_id"].includes(key))) return "Unknown send_group_message argument.";
      return null;
    case "propose_group_task": {
      if (typeof args.title !== "string" || !args.title.trim() || args.title.length > 160) return "title must contain 1-160 characters.";
      if (args.description !== undefined && (typeof args.description !== "string" || args.description.length > 12000)) return "description must be at most 12000 characters.";
      if (args.expected_output !== undefined && (typeof args.expected_output !== "string" || args.expected_output.length > 4000)) return "expected_output must be at most 4000 characters.";
      if (args.acceptance_criteria !== undefined && (!Array.isArray(args.acceptance_criteria) || args.acceptance_criteria.length > 20 || args.acceptance_criteria.some(value => typeof value !== "string" || !value.trim() || value.length > 500))) return "acceptance_criteria must contain at most 20 non-empty strings of at most 500 characters.";
      if (args.priority !== undefined && (!Number.isInteger(args.priority) || args.priority < 1 || args.priority > 5)) return "priority must be an integer from 1 to 5.";
      if (args.due_at !== undefined && (typeof args.due_at !== "string" || !Number.isFinite(Date.parse(args.due_at)))) return "due_at must be a valid date-time string.";
      if (typeof args.idempotency_key !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args.idempotency_key)) return "idempotency_key must be a UUID.";
      if (Object.keys(args).some(key => !["title", "description", "expected_output", "acceptance_criteria", "priority", "due_at", "idempotency_key"].includes(key))) return "Unknown propose_group_task argument.";
      return null;
    }
    case "read_group_task":
    case "claim_group_task":
      if (typeof args.task_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args.task_id)) return "task_id must be a UUID.";
      if (Object.keys(args).some(key => key !== "task_id")) return "Unknown task argument.";
      return null;
    case "block_group_task":
      if (typeof args.task_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args.task_id)) return "task_id must be a UUID.";
      if (typeof args.reason !== "string" || !args.reason.trim() || args.reason.length > 2000) return "reason must contain 1-2000 characters.";
      if (Object.keys(args).some(key => !["task_id", "reason"].includes(key))) return "Unknown block_group_task argument.";
      return null;
    case "fail_group_task":
      if (typeof args.task_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args.task_id)) return "task_id must be a UUID.";
      if (typeof args.reason !== "string" || !args.reason.trim() || args.reason.length > 2000) return "reason must contain 1-2000 characters.";
      if (Object.keys(args).some(key => !["task_id", "reason"].includes(key))) return "Unknown fail_group_task argument.";
      return null;
    case "submit_group_task_result":
      if (typeof args.task_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args.task_id)) return "task_id must be a UUID.";
      if (typeof args.result !== "string" || !args.result.trim() || args.result.length > 20000) return "result must contain 1-20000 characters.";
      if (typeof args.submission_key !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(args.submission_key)) return "submission_key must be a UUID.";
      if (args.source_message_ids !== undefined && (!Array.isArray(args.source_message_ids) || args.source_message_ids.length > 50 || args.source_message_ids.some(id => typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) || new Set(args.source_message_ids).size !== args.source_message_ids.length)) return "source_message_ids must contain at most 50 unique UUIDs.";
      if (Object.keys(args).some(key => !["task_id", "result", "submission_key", "source_message_ids"].includes(key))) return "Unknown submit_group_task_result argument.";
      return null;
    case "import_session_memory":
      if (!isRecord(args.document)) return "document must be a session-memory object.";
      if (Object.keys(args).some((key) => key !== "document")) return "Unknown import_session_memory argument.";
      return validateSessionMemoryDocument(args.document) ? null : "Invalid session-memory document; expected rub-minds.session-memory version 1 and a document no larger than 1 MiB.";
    case "forget_memory":
      if (typeof args.idempotency_key !== "string" || !/^browser-resume-[A-Za-z0-9-]{8,180}$/.test(args.idempotency_key)) return "idempotency_key must be a browser-resume key with 8-180 allowed characters after its prefix.";
      if (args.confirm_forget !== true) return "Explicit confirmation is required to delete private recovery memory.";
      if (Object.keys(args).some((key) => !["idempotency_key", "confirm_forget"].includes(key))) return "Unknown forget_memory argument.";
      return null;
    case "remember_memory":
      if (!["goal", "insight", "decision", "open_question", "progress", "summary"].includes(args.entry_type)) return "Invalid entry_type.";
      if (typeof args.content !== "string" || !args.content.trim() || args.content.length > 12000) return "content must contain 1-12000 characters.";
      if (!["private", "group"].includes(args.visibility)) return "visibility must explicitly be private or group.";
      if (typeof args.idempotency_key !== "string" || !args.idempotency_key.trim() || args.idempotency_key.length < 8 || args.idempotency_key.length > 200) return "idempotency_key must be 8-200 characters.";
      // Reserve this namespace for the exact kind of private browser locator
      // that forget_memory is allowed to delete. Generic private notes must not
      // become deletable just because they happen to use a matching key.
      if (args.idempotency_key.startsWith("browser-resume-") &&
          (args.entry_type !== "insight" || args.visibility !== "private" ||
           !args.content.startsWith("Original AI conversation recovery URL (private; do not post to group messages): "))) {
        return "browser-resume idempotency keys are reserved for private browser-recovery locator entries.";
      }
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
  if (Object.keys(document).some((key) => !["schema", "version", "summary", "current_goal", "source", "sharing", "transcript_text", "transcript_complete"].includes(key))) return false;
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
  if (document.transcript_text !== undefined &&
      (typeof document.transcript_text !== "string" || document.transcript_text.length > 900000)) return false;
  if (document.transcript_complete !== undefined &&
      (typeof document.transcript_complete !== "boolean" || typeof document.transcript_text !== "string")) return false;
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
