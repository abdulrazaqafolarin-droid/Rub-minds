import { createClient } from "npm:@supabase/supabase-js@2";
import { decryptCredential, encryptCredential } from "../../../integrations/mcp/credential-crypto.mjs";
import {
  MCP_PROTOCOL_VERSION,
  RUB_MINDS_MCP_TOOLS,
  isRecord,
  rpcError,
  rpcResult,
  validateSessionMemoryDocument,
  validateToolArguments,
  isAllowedMcpOrigin,
  validateProtocolVersionHeader,
} from "../../../integrations/mcp/protocol.mjs";

const databaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const credentialEncryptionKey = Deno.env.get("RUB_MINDS_MCP_SESSION_ENCRYPTION_KEY");
if (!databaseUrl || !serviceKey || !credentialEncryptionKey) throw new Error("Missing backend configuration or MCP credential-encryption secret");
// Validate key format at startup without retaining a second plaintext credential store.
if (!/^[a-f0-9]{64}$/i.test(credentialEncryptionKey)) throw new Error("RUB_MINDS_MCP_SESSION_ENCRYPTION_KEY must be 64 hexadecimal characters.");
const db = createClient(databaseUrl, serviceKey, { auth: { persistSession: false } });
const SESSION_TTL_HOURS = 24;
const MAX_REQUEST_BYTES = 1_200_000;

const reply = (status: number, body: unknown, sessionId?: string) => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
    "X-Content-Type-Options": "nosniff",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  return new Response(JSON.stringify(body), { status, headers });
};
const httpError = (status: number, message: string) => reply(status, { error: message });

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function newSessionId() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (isRecord(value)) return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stableStringify(value[key])).join(",") + "}";
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}
function toolResult(value: unknown, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) };
}
function validRpcEnvelope(input: unknown) {
  return isRecord(input) && input.jsonrpc === "2.0" && typeof input.method === "string" &&
    (input.id === undefined || typeof input.id === "string" || typeof input.id === "number");
}
async function findSession(sessionId: string) {
  if (!/^[a-f0-9]{64}$/.test(sessionId)) return null;
  const digest = await sha256(sessionId);
  const { data, error } = await db.from("rub_minds_mcp_sessions")
    .select("session_digest, agent_credential_ciphertext, room_id, participant_id, expires_at")
    .eq("session_digest", digest)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error || !data) return null;
  await db.from("rub_minds_mcp_sessions").update({ last_seen_at: new Date().toISOString() }).eq("session_digest", digest);
  return data;
}
async function invokeAgent(credential: string, operation: "read" | "send", payload: string | null = null, sourceMessageId: string | null = null) {
  const { data, error } = await db.rpc("agent_exchange", {
    agent_secret: credential,
    operation,
    payload,
    source_message_id: sourceMessageId,
  });
  if (error) {
    if (error.message?.includes("Agent request limit exceeded")) throw new Error("Rate limit exceeded. Retry after one minute.");
    throw new Error("AI participant credential is invalid or the operation was rejected.");
  }
  return data;
}
async function runTool(name: string, args: Record<string, unknown>, session: Record<string, unknown>) {
  if (name === "join_group") {
    if (session.agent_credential_ciphertext) return { joined: true, room_id: session.room_id, participant_id: session.participant_id, note: "This MCP session is already joined to a group." };
    const { data, error } = await db.rpc("redeem_ai_room_invite", {
      invite_token: args.invite_token,
      agent_label: (args.agent_label as string).trim(),
    });
    if (error || !isRecord(data) || typeof data.agent_secret !== "string" ||
        typeof data.room_id !== "string" || typeof data.participant_id !== "string") {
      throw new Error("Invitation is invalid, expired, revoked, or no longer permits another AI participant.");
    }
    const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000).toISOString();
    const { data: boundSession, error: bindError } = await db.from("rub_minds_mcp_sessions").update({
      agent_credential_ciphertext: await encryptCredential(data.agent_secret, credentialEncryptionKey),
      room_id: data.room_id,
      participant_id: data.participant_id,
      expires_at: expiresAt,
      last_seen_at: new Date().toISOString(),
    }).eq("session_digest", session.session_digest as string).is("agent_credential", null)
      .select("session_digest").maybeSingle();
    if (bindError || !boundSession) {
      await db.from("agent_connections").update({ revoked_at: new Date().toISOString() })
        .eq("credential_digest", await sha256(data.agent_secret)).is("revoked_at", null);
      throw new Error("Could not safely bind the AI participant to this MCP session.");
    }
    // Critical: never return data.agent_secret to the MCP client or model.
    return { joined: true, room_id: data.room_id, participant_id: data.participant_id, expires_at: expiresAt };
  }

  const encryptedCredential = session.agent_credential_ciphertext;
  if (typeof encryptedCredential !== "string" || !encryptedCredential) {
    throw new Error("This MCP session has not joined a group. Call join_group with a valid invite first.");
  }
  const credential = await decryptCredential(encryptedCredential, credentialEncryptionKey);

  if (name === "read_group_messages") {
    const data = await invokeAgent(credential, "read");
    if (isRecord(data) && Array.isArray(data.messages)) {
      const ids = [...new Set(data.messages.map((message) => isRecord(message) ? message.sender_id : null).filter((id) => typeof id === "string"))] as string[];
      if (ids.length) {
        const { data: participants, error } = await db.from("participants").select("id,display_name,kind").in("id", ids);
        if (error) throw new Error("Could not resolve group message participants.");
        const byId = new Map((participants || []).map((p: { id: string; display_name: string; kind: string }) => [p.id, p]));
        data.messages = data.messages.map((message: Record<string, unknown>) => {
          const p = byId.get(message.sender_id as string);
          return { ...message, sender_name: p?.display_name || "Participant", sender_kind: p?.kind || "unknown" };
        });
      }
    }
    return data;
  }

  if (name === "send_group_message") {
    return await invokeAgent(credential, "send", args.body as string, (args.source_message_id as string | undefined) || null);
  }

  const credentialDigest = await sha256(credential);
  const { data: connection, error: connectionError } = await db.from("agent_connections")
    .select("id, room_id, participant_id, owner_id, expires_at, revoked_at")
    .eq("credential_digest", credentialDigest).is("revoked_at", null)
    .gt("expires_at", new Date().toISOString()).maybeSingle();
  if (connectionError || !connection) throw new Error("AI participant credential is invalid, expired, or revoked.");
  await invokeAgent(credential, "read");

  if (name === "read_session_memory") {
    const { data: imports, error: importsError } = await db.from("room_session_imports")
      .select("id, document_version, source_platform, title, context_summary, imported_context, content_sha256, created_at")
      .eq("room_id", connection.room_id).eq("participant_id", connection.participant_id)
      .order("created_at", { ascending: false }).limit(10);
    if (importsError) throw new Error("Could not load imported session memory.");
    const { data: memory, error: memoryError } = await db.from("room_memory_entries")
      .select("id, entry_type, visibility, content, source_message_ids, created_at, updated_at")
      .eq("room_id", connection.room_id)
      .or("visibility.eq.group,created_by_participant_id.eq." + connection.participant_id)
      .order("updated_at", { ascending: false }).limit(100);
    if (memoryError) throw new Error("Could not load group memory.");
    // Do not return raw imported history to every tool call; expose only the bounded summary and current goal.
    const safeImports = (imports || []).map((entry: Record<string, unknown>) => {
      const document = isRecord(entry.imported_context) ? entry.imported_context : {};
      return {
        id: entry.id, document_version: entry.document_version, source_platform: entry.source_platform,
        title: entry.title, context_summary: entry.context_summary,
        current_goal: typeof document.current_goal === "string" ? document.current_goal : "",
        content_sha256: entry.content_sha256, created_at: entry.created_at,
      };
    });
    return { room_id: connection.room_id, participant_id: connection.participant_id, imports: safeImports, group_memory: memory || [] };
  }

  if (name === "import_session_memory") {
    const document = args.document as Record<string, unknown>;
    const source = document.source as Record<string, unknown>;
    const title = typeof source.session_label === "string" && source.session_label.trim()
      ? source.session_label.trim().slice(0, 160) : "Imported AI session";
    const { data, error } = await db.from("room_session_imports").insert({
      room_id: connection.room_id,
      participant_id: connection.participant_id,
      owner_id: connection.owner_id,
      document_version: 1,
      source_platform: (source.platform as string).trim().slice(0, 80),
      title,
      context_summary: (document.summary as string).slice(0, 20000),
      imported_context: document,
      content_sha256: await sha256(stableStringify(document)),
    }).select("id, room_id, participant_id, document_version, source_platform, title, context_summary, content_sha256, created_at").single();
    if (error || !data) throw new Error("Could not save the private session import.");
    return { imported: true, session: data, visibility: "private" };
  }

  if (name === "remember_memory") {
    let sourceImportId: string | null = null;
    if (typeof args.source_import_id === "string") {
      const { data: sourceImport } = await db.from("room_session_imports").select("id")
        .eq("id", args.source_import_id).eq("room_id", connection.room_id)
        .eq("participant_id", connection.participant_id).maybeSingle();
      if (!sourceImport) throw new Error("Session import not found for this participant.");
      sourceImportId = sourceImport.id;
    }
    const { data, error } = await db.from("room_memory_entries").insert({
      room_id: connection.room_id,
      source_import_id: sourceImportId,
      created_by_participant_id: connection.participant_id,
      owner_id: connection.owner_id,
      entry_type: args.entry_type,
      visibility: args.visibility,
      content: (args.content as string).trim(),
      source_message_ids: args.source_message_ids || [],
      idempotency_key: args.idempotency_key,
    }).select("id, entry_type, visibility, content, source_message_ids, created_at").single();
    if (error || !data) {
      if (error?.code === "23505") throw new Error("Memory entry already recorded for this idempotency key.");
      throw new Error("Could not save memory entry.");
    }
    return { remembered: true, entry: data };
  }
  throw new Error("Unknown tool.");
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("Origin");
  if (!isAllowedMcpOrigin(origin)) return httpError(403, "Origin is not allowed.");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "content-type, mcp-session-id, mcp-protocol-version, accept", "Vary": "Origin" } });
  if (request.method !== "POST") return httpError(405, "MCP endpoint accepts POST requests only.");
  const accept = request.headers.get("Accept") || "";
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) return httpError(406, "Accept must include both application/json and text/event-stream.");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) return httpError(413, "Request too large.");
  let input: unknown;
  try { input = JSON.parse(raw); } catch { return httpError(400, "Invalid JSON."); }
  if (!validRpcEnvelope(input)) return reply(400, rpcError(null, -32600, "Invalid JSON-RPC request."));
  const rpc = input as Record<string, unknown>;
  const hasId = rpc.id !== undefined;
  const id = rpc.id as string | number | undefined;
  const method = rpc.method as string;
  const params = isRecord(rpc.params) ? rpc.params : {};
  const protocolHeaderError = validateProtocolVersionHeader(method, request.headers.get("MCP-Protocol-Version"));
  if (protocolHeaderError) return reply(400, rpcError(id ?? null, -32600, protocolHeaderError));

  if (method === "initialize") {
    if (!hasId) return reply(400, rpcError(null, -32600, "initialize must be a request."));
    const sessionId = newSessionId();
    const sessionDigest = await sha256(sessionId);
    const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000).toISOString();
    const { error } = await db.from("rub_minds_mcp_sessions").insert({ session_digest: sessionDigest, expires_at: expiresAt });
    if (error) return reply(503, rpcError(id, -32603, "Could not create an MCP session."));
    await db.from("rub_minds_mcp_sessions").delete().lt("expires_at", new Date().toISOString());
    return reply(200, rpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "rub-minds", version: "0.1.0" },
      instructions: "Use join_group with a valid invitation and explicit confirmation. Session imports are private by default; group memory is shared only when visibility is explicitly set to group.",
    }), sessionId);
  }

  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return hasId ? reply(200, rpcError(id, -32600, "Notifications must not include an id.")) : new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
  }

  const sessionId = request.headers.get("Mcp-Session-Id") || "";
  const session = await findSession(sessionId);
  if (!session) return httpError(404, "MCP session missing, expired, or invalid. Reconnect the Rub Minds MCP server.");
  if (!hasId) return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });

  if (method === "ping") return reply(200, rpcResult(id, {}), sessionId);
  if (method === "tools/list") return reply(200, rpcResult(id, { tools: RUB_MINDS_MCP_TOOLS }), sessionId);
  if (method !== "tools/call") return reply(200, rpcError(id, -32601, "Method not found."), sessionId);

  const toolName = params.name;
  const args = params.arguments === undefined ? {} : params.arguments;
  if (typeof toolName !== "string") return reply(200, rpcError(id, -32602, "Tool name is required."), sessionId);
  const validationError = validateToolArguments(toolName, args);
  if (validationError) return reply(200, rpcError(id, -32602, validationError), sessionId);
  try {
    const result = await runTool(toolName, args as Record<string, unknown>, session);
    return reply(200, rpcResult(id, toolResult(result)), sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool call failed.";
    const safe = message.length > 300 ? message.slice(0, 300) : message;
    return reply(200, rpcResult(id, toolResult({ error: safe }, true)), sessionId);
  }
});
