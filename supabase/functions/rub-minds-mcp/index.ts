import { createClient } from "npm:@supabase/supabase-js@2";
import { consumePublicRateLimit, publicRateLimitResponse } from "../_shared/public-rate-limit.ts";
import { decryptWithKeyRing, encryptWithKeyRing, validateCredentialKeyRing } from "../../../integrations/mcp/credential-keyring.mjs";
import { selectSessionHandleForRetry } from "../../../integrations/mcp/session-handle-keyring.mjs";
import { deriveJoinCredential } from "../../../integrations/mcp/join-credential.mjs";
import {
  MCP_PROTOCOL_VERSION,
  MCP_MODERN_PROTOCOL_VERSION,
  getModernMcpTools,
  validateModernRequestMetadata,
  RUB_MINDS_MCP_TOOLS,
  isRecord,
  rpcError,
  rpcResult,
  validateSessionMemoryDocument,
  validateToolArguments,
  isAllowedMcpOrigin,
  validateProtocolVersionHeader,
  applyMcpCors,
  isJsonContentType,
} from "../../../integrations/mcp/protocol.mjs";

const databaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const credentialEncryptionKey = Deno.env.get("RUB_MINDS_MCP_SESSION_ENCRYPTION_KEY");
if (!databaseUrl || !serviceKey || !credentialEncryptionKey) throw new Error("Missing backend configuration or MCP credential-encryption secret");
const publicRateLimitSecret: string = serviceKey;
// Previous keys are optional, decryption/retry-only. Keep them configured through the maximum session/idempotency lifetime.
const previousKeySetting = Deno.env.get("RUB_MINDS_MCP_SESSION_ENCRYPTION_KEYS_PREVIOUS") || "";
const previousEncryptionKeys = previousKeySetting ? previousKeySetting.split(",").map((key) => key.trim()).filter(Boolean) : [];
const credentialEncryptionKeys = validateCredentialKeyRing(credentialEncryptionKey, previousEncryptionKeys);
const db = createClient(databaseUrl, serviceKey, { auth: { persistSession: false } });
const SESSION_TTL_HOURS = 24;
const TERMINATED_TOMBSTONE_HOURS = 168;
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

async function consumeSessionRateLimit(session: Record<string, unknown>) {
  const { data, error } = await db.rpc("consume_mcp_session_rate_limit", {
    p_session_digest: session.session_digest,
    p_max_requests: 60,
    p_window_seconds: 60,
  });
  if (error) throw new Error("MCP session rate limiter is unavailable; request blocked.");
  return data === true;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (isRecord(value)) return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stableStringify(value[key])).join(",") + "}";
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}
function newSessionId() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
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
    .select("session_digest, agent_credential_ciphertext, room_id, participant_id, expires_at, terminated_at")
    .eq("session_digest", digest)
    .gt("expires_at", new Date().toISOString())
    .is("terminated_at", null)
    .maybeSingle();
  if (error || !data) return null;
  await db.from("rub_minds_mcp_sessions").update({ last_seen_at: new Date().toISOString() }).eq("session_digest", digest);
  return data;
}
async function terminateMcpSession(sessionDigest: string) {
  const { data: closingSession, error: lookupError } = await db.from("rub_minds_mcp_sessions")
    .select("session_digest, agent_credential_ciphertext, terminated_at")
    .eq("session_digest", sessionDigest)
    .maybeSingle();
  if (lookupError) throw new Error("Could not verify the MCP session before termination.");
  if (!closingSession) return { terminated: false, alreadyTerminated: false };
  if (closingSession.terminated_at) return { terminated: true, alreadyTerminated: true };
  if (typeof closingSession.agent_credential_ciphertext === "string") {
    let credential: string;
    try {
      credential = await decryptWithKeyRing(closingSession.agent_credential_ciphertext, credentialEncryptionKey, previousEncryptionKeys, sessionDigest);
    } catch {
      throw new Error("Could not securely close the AI participant session. Retry or wait for expiry.");
    }
    const { error: revokeError } = await db.from("agent_connections")
      .update({ revoked_at: new Date().toISOString() })
      .eq("credential_digest", await sha256(credential))
      .is("revoked_at", null);
    if (revokeError) throw new Error("Could not revoke the AI participant session. Retry or wait for expiry.");
  }
  const terminatedAt = new Date().toISOString();
  const tombstoneExpiry = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000).toISOString();
  const { error: terminateError } = await db.from("rub_minds_mcp_sessions").update({
    agent_credential_ciphertext: null, room_id: null, participant_id: null,
    terminated_at: terminatedAt, expires_at: tombstoneExpiry, last_seen_at: terminatedAt,
  }).eq("session_digest", sessionDigest).is("terminated_at", null);
  if (terminateError) throw new Error("Could not terminate the MCP session. Retry or wait for expiry.");
  return { terminated: true, alreadyTerminated: false };
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

async function enrichGroupMessages(data: unknown) {
  if (!isRecord(data) || !Array.isArray(data.messages)) return data;
  const ids = [...new Set(data.messages.map((message) => isRecord(message) ? message.sender_id : null).filter((id) => typeof id === "string"))] as string[];
  if (!ids.length) return data;
  const { data: participants, error } = await db.from("participants").select("id,display_name,kind").in("id", ids);
  if (error) throw new Error("Could not resolve group message participants.");
  const byId = new Map((participants || []).map((p: { id: string; display_name: string; kind: string }) => [p.id, p]));
  data.messages = data.messages.map((message: Record<string, unknown>) => {
    const participant = byId.get(message.sender_id as string);
    return { ...message, sender_name: participant?.display_name || "Participant", sender_kind: participant?.kind || "unknown" };
  });
  return data;
}
async function runTool(name: string, args: Record<string, unknown>, session: Record<string, unknown>) {
  if (name === "join_group") {
    if (typeof session.agent_credential_ciphertext === "string") {
      const existingCredential = await decryptWithKeyRing(session.agent_credential_ciphertext, credentialEncryptionKey, previousEncryptionKeys, session.session_digest as string);
      const { data: activeConnection, error: activeConnectionError } = await db.from("agent_connections")
        .select("id").eq("credential_digest", await sha256(existingCredential))
        .is("revoked_at", null).gt("expires_at", new Date().toISOString()).maybeSingle();
      if (activeConnectionError) throw new Error("Could not verify the existing AI participant session.");
      if (activeConnection) return { joined: true, room_id: session.room_id, participant_id: session.participant_id, note: "This MCP session is already joined to an active group." };
      const { error: clearError } = await db.from("rub_minds_mcp_sessions").update({
        agent_credential_ciphertext: null, room_id: null, participant_id: null,
      }).eq("session_digest", session.session_digest as string)
        .eq("agent_credential_ciphertext", session.agent_credential_ciphertext);
      if (clearError) throw new Error("Could not clear the expired or revoked AI participant binding.");
      session.agent_credential_ciphertext = null;
      session.room_id = null;
      session.participant_id = null;
    }
    const modernIdempotentJoin = session._modern_idempotent_join === true;
    const deterministicCredential = modernIdempotentJoin
      ? await deriveJoinCredential((session._session_handle_key as string) || credentialEncryptionKey, session.session_handle as string)
      : null;
    const { data, error } = modernIdempotentJoin
      ? await db.rpc("redeem_ai_room_invite_idempotent", {
          p_invite_token: (args.invite_token as string).toLowerCase(),
          p_agent_label: (args.agent_label as string).trim(),
          p_session_digest: session.session_digest as string,
          p_credential_digest: await sha256(deterministicCredential as string),
        })
      : await db.rpc("redeem_ai_room_invite", {
          invite_token: (args.invite_token as string).toLowerCase(),
          agent_label: (args.agent_label as string).trim(),
        });
    const credential = modernIdempotentJoin ? deterministicCredential : (isRecord(data) ? data.agent_secret : null);
    if (error || !isRecord(data) || typeof credential !== "string" ||
        typeof data.room_id !== "string" || typeof data.participant_id !== "string" || typeof data.expires_at !== "string") {
      throw new Error("Invitation is invalid, expired, revoked, or no longer permits another AI participant.");
    }
    const credentialExpiry = Date.parse(data.expires_at);
    if (!Number.isFinite(credentialExpiry) || credentialExpiry <= Date.now()) {
      if (!modernIdempotentJoin) {
        await db.from("agent_connections").update({ revoked_at: new Date().toISOString() })
          .eq("credential_digest", await sha256(credential)).is("revoked_at", null);
      }
      throw new Error("The AI invitation credential has already expired.");
    }
    const expiresAt = new Date(Math.min(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000, credentialExpiry)).toISOString();
    let encryptedCredential: string;
    try {
      encryptedCredential = await encryptWithKeyRing(credential, credentialEncryptionKey, session.session_digest as string);
    } catch {
      if (!modernIdempotentJoin) {
        await db.from("agent_connections").update({ revoked_at: new Date().toISOString() })
          .eq("credential_digest", await sha256(credential)).is("revoked_at", null);
      }
      throw new Error("Could not securely bind the AI participant to this MCP session.");
    }
    const binding = {
      session_digest: session.session_digest as string,
      agent_credential_ciphertext: encryptedCredential,
      room_id: data.room_id,
      participant_id: data.participant_id,
      expires_at: expiresAt,
      last_seen_at: new Date().toISOString(),
    };
    const isNewSession = session._new_session === true;
    const { data: boundSession, error: bindError } = isNewSession
      ? await db.from("rub_minds_mcp_sessions").insert(binding).select("session_digest").maybeSingle()
      : await db.from("rub_minds_mcp_sessions").update({
          agent_credential_ciphertext: encryptedCredential,
          room_id: data.room_id,
          participant_id: data.participant_id,
          expires_at: expiresAt,
          last_seen_at: new Date().toISOString(),
        }).eq("session_digest", session.session_digest as string)
          .is("agent_credential_ciphertext", null)
          .is("terminated_at", null)
          .gt("expires_at", new Date().toISOString())
          .select("session_digest").maybeSingle();
    if (bindError || !boundSession) {
      if (modernIdempotentJoin) {
        // A concurrent retry may have won the unique session_digest insert.
        // Re-read and accept only the exact same atomic join result; never revoke
        // the shared deterministic credential just because this duplicate insert lost.
        const { data: concurrentBinding, error: concurrentLookupError } = await db.from("rub_minds_mcp_sessions")
          .select("session_digest, room_id, participant_id, terminated_at, expires_at")
          .eq("session_digest", session.session_digest as string)
          .maybeSingle();
        if (!concurrentLookupError && concurrentBinding &&
            concurrentBinding.room_id === data.room_id &&
            concurrentBinding.participant_id === data.participant_id &&
            concurrentBinding.terminated_at === null &&
            Date.parse(concurrentBinding.expires_at) > Date.now()) {
          return { joined: true, room_id: data.room_id, participant_id: data.participant_id, expires_at: concurrentBinding.expires_at, replayed: true };
        }
      } else {
        await db.from("agent_connections").update({ revoked_at: new Date().toISOString() })
          .eq("credential_digest", await sha256(credential)).is("revoked_at", null);
      }
      throw new Error("Could not safely bind the AI participant to this MCP session.");
    }
    if (isNewSession) {
      // Clean old sessions only after a valid invite has been redeemed successfully.
      const now = Date.now();
      await db.from("rub_minds_mcp_sessions").delete().lt("expires_at", new Date(now).toISOString()).is("terminated_at", null);
      await db.from("rub_minds_mcp_sessions").delete().lt("terminated_at", new Date(now - TERMINATED_TOMBSTONE_HOURS * 60 * 60 * 1000).toISOString());
    }
    // Critical: never return data.agent_secret to the MCP client or model.
    return { joined: true, room_id: data.room_id, participant_id: data.participant_id, expires_at: expiresAt };
  }

  if (name === "leave_group") {
    if (args.confirm_leave !== true) throw new Error("Explicit confirmation is required to leave and revoke this group session.");
    const outcome = await terminateMcpSession(session.session_digest as string);
    return { left: true, already_terminated: outcome.alreadyTerminated || !outcome.terminated };
  }

  const encryptedCredential = session.agent_credential_ciphertext;
  if (typeof encryptedCredential !== "string" || !encryptedCredential) {
    throw new Error("This MCP session has not joined a group. Call join_group with a valid invite first.");
  }
  const credential = await decryptWithKeyRing(encryptedCredential, credentialEncryptionKey, previousEncryptionKeys, session.session_digest as string);

  if (name === "read_group_context") {
    // Validate the credential (including revocation/expiry) before exposing room metadata.
    await invokeAgent(credential, "read");
    const { data: room, error: roomError } = await db.from("rooms")
      .select("id, title, objective, created_at")
      .eq("id", session.room_id as string).maybeSingle();
    if (roomError || !room) throw new Error("Could not load the joined group context.");
    const { data: participants, error: participantError } = await db.from("participants")
      .select("display_name, kind, status, created_at")
      .eq("room_id", session.room_id as string)
      .order("created_at", { ascending: true }).limit(100);
    if (participantError) throw new Error("Could not load group participants.");
    return { room, participants: participants || [] };
  }

  if (name === "read_group_messages") {
    return await enrichGroupMessages(await invokeAgent(credential, "read"));
  }

  if (name === "wait_for_group_messages") {
    const timeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : 10000;
    const cursor = typeof args.after_created_at === "string" ? Date.parse(args.after_created_at) : Date.now();
    const cursorMessageId = typeof args.after_message_id === "string" ? args.after_message_id : null;
    const messagesAfterCursor = (data: unknown) => {
      if (!isRecord(data) || !Array.isArray(data.messages)) return [];
      const messages = data.messages.filter((message) => isRecord(message) &&
        typeof message.created_at === "string" && Number.isFinite(Date.parse(message.created_at)));
      // Prefer an exact message cursor when it is still in the bounded read window.
      // This avoids replaying the last processed message and handles equal timestamps.
      if (cursorMessageId) {
        const index = messages.findIndex((message) => message.id === cursorMessageId);
        if (index >= 0) return messages.slice(index + 1);
      }
      // If the exact cursor fell outside the read window, fall back to strict time
      // ordering. Strict > avoids replaying a message whose timestamp equals cursor.
      return messages.filter((message) => Date.parse(message.created_at as string) > cursor);
    };
    const hasNewMessages = (data: unknown) => messagesAfterCursor(data).length > 0;
    const onlyNewMessages = async (data: unknown) => {
      if (!isRecord(data)) return { messages: [] };
      return await enrichGroupMessages({ ...data, messages: messagesAfterCursor(data) });
    };
    const initial = await invokeAgent(credential, "read");
    if (hasNewMessages(initial)) return { timed_out: false, delivery: "realtime", ...(await onlyNewMessages(initial) as Record<string, unknown>) };

    const roomId = session.room_id;
    if (typeof roomId !== "string" || !/^[0-9a-f-]{36}$/i.test(roomId)) throw new Error("The joined group binding is invalid.");
    // The service credential is server-only. The channel is filtered to the
    // authenticated session's room and payloads are never returned to the model.
    db.realtime.setAuth(serviceKey);
    const channel = db.channel("mcp-room-wait-" + roomId + "-" + crypto.randomUUID());
    let eventSeen = false;
    let wakeWaiter: (() => void) | null = null;
    let eventTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      const subscribed = await new Promise<boolean>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => { if (!settled) { settled = true; resolve(false); } }, 3000);
        channel.on("postgres_changes", {
          event: "INSERT", schema: "public", table: "messages", filter: "room_id=eq." + roomId,
        }, () => {
          eventSeen = true;
          wakeWaiter?.();
        }).subscribe((status: string) => {
          if (settled) return;
          if (status === "SUBSCRIBED") { settled = true; clearTimeout(timer); resolve(true); }
          else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") { settled = true; clearTimeout(timer); resolve(false); }
        });
      });
      if (!subscribed) return { timed_out: true, delivery: "unavailable", messages: [], note: "Supabase Realtime subscription could not be established. Retry read_group_messages or wait_for_group_messages." };

      // Read after subscribing to close the read/subscribe race. Realtime payloads
      // are only wake-up signals; the authorized group read remains the source of truth.
      const afterSubscribe = await invokeAgent(credential, "read");
      if (hasNewMessages(afterSubscribe)) return { timed_out: false, delivery: "realtime", ...(await onlyNewMessages(afterSubscribe) as Record<string, unknown>) };
      if (eventSeen) {
        const afterEvent = await invokeAgent(credential, "read");
        if (hasNewMessages(afterEvent)) return { timed_out: false, delivery: "realtime", ...(await onlyNewMessages(afterEvent) as Record<string, unknown>) };
      }
      const eventOrTimeout = await new Promise<"message" | "timeout">((resolve) => {
        eventTimer = setTimeout(() => resolve("timeout"), timeoutMs);
        wakeWaiter = () => {
          if (eventTimer) clearTimeout(eventTimer);
          resolve("message");
        };
        if (eventSeen) wakeWaiter();
      });
      if (eventOrTimeout === "timeout") return { timed_out: true, delivery: "realtime", messages: [] };
      const afterEvent = await invokeAgent(credential, "read");
      return { timed_out: !hasNewMessages(afterEvent), delivery: "realtime", ...(await onlyNewMessages(afterEvent) as Record<string, unknown>) };
    } finally {
      if (eventTimer) clearTimeout(eventTimer);
      try { await db.removeChannel(channel); } catch { /* best-effort cleanup for this bounded subscription */ }
    }
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
    let sourceMessageIds: string[] = [];
    if (Array.isArray(args.source_message_ids) && args.source_message_ids.length) {
      const requestedIds = args.source_message_ids as string[];
      const { data: sourceMessages, error: sourceMessagesError } = await db.from("messages")
        .select("id")
        .eq("room_id", connection.room_id)
        .in("id", requestedIds);
      if (sourceMessagesError) throw new Error("Could not verify memory provenance messages.");
      const verifiedIds = new Set((sourceMessages || []).map((message: { id: string }) => message.id));
      if (verifiedIds.size !== requestedIds.length || requestedIds.some((id) => !verifiedIds.has(id))) {
        throw new Error("Every source message must belong to this group.");
      }
      sourceMessageIds = requestedIds;
    }
    const { data, error } = await db.from("room_memory_entries").insert({
      room_id: connection.room_id,
      source_import_id: sourceImportId,
      created_by_participant_id: connection.participant_id,
      owner_id: connection.owner_id,
      entry_type: args.entry_type,
      visibility: args.visibility,
      content: (args.content as string).trim(),
      source_message_ids: sourceMessageIds,
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

function modernRpcError(status: number, id: string | number | null, code: number, message: string, data?: unknown) {
  return reply(status, { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

function modernToolResult(id: string | number, value: unknown, isError = false) {
  return reply(200, rpcResult(id, {
    resultType: "complete",
    _meta: { "io.modelcontextprotocol/serverInfo": { name: "rub-minds", version: "0.1.0" } },
    ...toolResult(value, isError),
  }));
}

async function handleModernMcpRpc(request: Request, rpc: Record<string, unknown>, params: Record<string, unknown>, id: string | number | null, hasId: boolean) {
  const method = rpc.method as string;
  const metadataError = validateModernRequestMetadata(method, {
    protocolVersion: request.headers.get("MCP-Protocol-Version"),
    method: request.headers.get("Mcp-Method"),
    name: request.headers.get("Mcp-Name"),
  }, params);
  if (metadataError) return modernRpcError(metadataError.status, id, metadataError.code, metadataError.message, metadataError.data);
  if (method === "server/discover") {
    if (!hasId || id === null) return modernRpcError(400, null, -32600, "server/discover must be a request.");
    return reply(200, rpcResult(id, {
      resultType: "complete",
      supportedVersions: [MCP_MODERN_PROTOCOL_VERSION],
      capabilities: { tools: {} },
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "rub-minds", version: "0.1.0" } },
      instructions: "Use join_group with explicit confirmation and a unique 64-character hexadecimal join_request_key. Reuse that key only when retrying the same join request. It returns an opaque session_handle that must be passed to subsequent tool calls; use leave_group with explicit confirmation to revoke the participant and terminate the handle. Session imports remain private by default; group memory is shared only when visibility is explicitly set to group.",
      ttlMs: 3600000,
      cacheScope: "public",
    }));
  }
  if (!hasId) return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
  if (id === null) return modernRpcError(400, null, -32600, "Request id is required.");
  if (method === "tools/list") {
    return reply(200, rpcResult(id, { resultType: "complete", tools: getModernMcpTools(), ttlMs: 300000, cacheScope: "public", _meta: { "io.modelcontextprotocol/serverInfo": { name: "rub-minds", version: "0.1.0" } } }));
  }
  if (method !== "tools/call") return modernRpcError(404, id, -32601, "Method not found.");

  const toolName = params.name;
  if (typeof toolName !== "string") return modernRpcError(200, id, -32602, "Tool name is required.");
  if (params.arguments !== undefined && !isRecord(params.arguments)) return modernRpcError(200, id, -32602, "Tool arguments must be a JSON object.");
  const rawArgs: Record<string, unknown> = { ...(isRecord(params.arguments) ? params.arguments : {}) };
  let sessionHandle: string;
  let session: Record<string, unknown> | null;
  if (toolName === "join_group") {
    const joinKey = rawArgs.join_request_key;
    if (typeof joinKey !== "string" || !/^[a-f0-9]{64}$/i.test(joinKey) || typeof rawArgs.invite_token !== "string" || !/^[a-f0-9]{64}$/i.test(rawArgs.invite_token) || typeof rawArgs.agent_label !== "string" || !rawArgs.agent_label.trim() || [...rawArgs.agent_label.trim()].length > 80) {
      return modernRpcError(200, id, -32602, "join_group requires a valid invitation token, agent_label, and 64-character hexadecimal join_request_key.");
    }
    try {
      const selection = await selectSessionHandleForRetry(
        credentialEncryptionKeys,
        rawArgs.invite_token,
        rawArgs.agent_label,
        joinKey,
        async (candidateHandle: string) => {
          const candidateDigest = await sha256(candidateHandle);
          const { data: existingSession, error: sessionLookupError } = await db.from("rub_minds_mcp_sessions")
            .select("session_digest").eq("session_digest", candidateDigest).maybeSingle();
          if (sessionLookupError) throw new Error("Could not verify an existing session retry.");
          if (existingSession) return true;
          // Session rows may be cleaned after their short handle TTL while the
          // durable idempotency record remains valid. Preserve the old key choice.
          const { data: existingJoin, error: joinLookupError } = await db.from("rub_minds_mcp_join_requests")
            .select("session_digest").eq("session_digest", candidateDigest).maybeSingle();
          if (joinLookupError) throw new Error("Could not verify a durable join retry.");
          return Boolean(existingJoin);
        },
      );
      sessionHandle = selection.handle;
      rawArgs._selected_handle_key = selection.key;
    } catch {
      return modernRpcError(503, id, -32000, "Could not securely resolve the join retry. Check key-ring configuration and retry.");
    }
    delete rawArgs.join_request_key;
    session = await findSession(sessionHandle);
    if (!session) {
      const sessionDigest = await sha256(sessionHandle);
      const { data: priorSession, error: lookupError } = await db.from("rub_minds_mcp_sessions")
        .select("session_digest")
        .eq("session_digest", sessionDigest)
        .maybeSingle();
      if (lookupError) return modernRpcError(503, id, -32000, "Could not verify the join handle before joining.");
      if (priorSession) {
        // Another concurrent join may have inserted its live session between
        // findSession() and this tombstone check. Re-read before declaring the
        // handle expired; a terminated/expired handle still fails closed.
        session = await findSession(sessionHandle);
        if (!session) return modernToolResult(id, { error: "This join handle has expired or was terminated. Start a new join request with a new join_request_key." }, true);
      } else {
        session = { session_digest: sessionDigest, agent_credential_ciphertext: null, room_id: null, participant_id: null, _new_session: true };
      }
    }
    session.session_handle = sessionHandle;
    session._session_handle_key = rawArgs._selected_handle_key;
    delete rawArgs._selected_handle_key;
    session._modern_idempotent_join = true;
  } else {
    const handle = rawArgs.session_handle;
    if (typeof handle !== "string" || !/^[a-f0-9]{64}$/i.test(handle)) return modernRpcError(200, id, -32602, "A valid session_handle returned by join_group is required.");
    sessionHandle = handle.toLowerCase();
    delete rawArgs.session_handle;
    session = await findSession(sessionHandle);
    if (!session) return modernToolResult(id, { error: "Session handle is missing, expired, or terminated. Call join_group again with a fresh join_request_key." }, true);
  }
  if (session._new_session !== true) {
    try {
      if (!await consumeSessionRateLimit(session)) return modernToolResult(id, { error: "Rate limit exceeded: this MCP session may make 60 tool calls per minute. Wait briefly and retry." }, true);
    } catch {
      return modernRpcError(503, id, -32000, "MCP session rate limiter is unavailable; request blocked.");
    }
  }
  const validationError = validateToolArguments(toolName, rawArgs);
  if (validationError) return modernRpcError(200, id, -32602, validationError);
  try {
    const result = await runTool(toolName, rawArgs, session);
    return modernToolResult(id, toolName === "join_group" && isRecord(result) ? { ...result, session_handle: sessionHandle } : result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool call failed.";
    const safe = message.length > 300 ? message.slice(0, 300) : message;
    return modernToolResult(id, { error: safe }, true);
  }
}

async function handleMcpRequest(request: Request) {
  const origin = request.headers.get("Origin");
  if (!isAllowedMcpOrigin(origin)) return httpError(403, "Origin is not allowed.");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS", "Access-Control-Allow-Headers": "content-type, mcp-session-id, mcp-protocol-version, mcp-method, mcp-name, accept", "Vary": "Origin" } });
  if (request.method === "POST" || request.method === "DELETE") {
    try {
      const allowed = await consumePublicRateLimit(db, request, publicRateLimitSecret, "rub-minds-mcp-requests", 600, 60);
      if (!allowed) return publicRateLimitResponse({
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Pragma": "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
    } catch {
      return httpError(503, "MCP request rate limiter is unavailable; request blocked.");
    }
  }
  if (request.method === "DELETE") {
    // Legacy transport clients may explicitly terminate their session. The
    // session ID is a bearer capability, so hash it before lookup.
    const sessionId = request.headers.get("Mcp-Session-Id") || "";
    if (!/^[a-f0-9]{64}$/.test(sessionId)) return httpError(404, "MCP session missing or invalid.");
    try {
      await terminateMcpSession(await sha256(sessionId));
    } catch {
      return httpError(503, "Could not safely terminate the MCP session. Retry or wait for expiry.");
    }
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache" } });
  }
  if (request.method !== "POST") return httpError(405, "MCP endpoint accepts POST or DELETE requests only.");
  if (!isJsonContentType(request.headers.get("Content-Type"))) return httpError(415, "Content-Type must be application/json.");
  const accept = request.headers.get("Accept") || "";
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) return httpError(406, "Accept must include both application/json and text/event-stream.");
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) return httpError(400, "Invalid Content-Length.");
    if (length > MAX_REQUEST_BYTES) return httpError(413, "Request too large.");
  }
  if (!request.body) return httpError(400, "Request body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return httpError(413, "Request too large.");
      }
      chunks.push(value);
    }
  } catch {
    return httpError(400, "Could not read request body.");
  }
  const bodyBytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let raw: string;
  try { raw = new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes); }
  catch { return httpError(400, "Request body must be valid UTF-8."); }
  let input: unknown;
  try { input = JSON.parse(raw); } catch { return httpError(400, "Invalid JSON."); }
  if (!validRpcEnvelope(input)) return reply(400, rpcError(null, -32600, "Invalid JSON-RPC request."));
  const rpc = input as Record<string, unknown>;
  const hasId = rpc.id !== undefined;
  const id = rpc.id as string | number | undefined;
  const method = rpc.method as string;
  const params = isRecord(rpc.params) ? rpc.params : {};
  if (method === "tools/call" && params.name === "join_group") {
    try {
      const allowed = await consumePublicRateLimit(db, request, publicRateLimitSecret, "rub-minds-mcp-join", 10, 60);
      if (!allowed) return reply(429, rpcError(id ?? null, -32000, "MCP join rate limit exceeded. Retry after one minute."), request.headers.get("Mcp-Session-Id") || undefined);
    } catch {
      return reply(503, rpcError(id ?? null, -32000, "MCP join rate limiter is unavailable; request blocked."), request.headers.get("Mcp-Session-Id") || undefined);
    }
  }
  const suppliedVersion = request.headers.get("MCP-Protocol-Version");
  const bodyMeta = isRecord(params._meta) ? params._meta : {};
  const bodyProtocolVersion = bodyMeta["io.modelcontextprotocol/protocolVersion"];
  if (method === "server/discover" || suppliedVersion === MCP_MODERN_PROTOCOL_VERSION || bodyProtocolVersion === MCP_MODERN_PROTOCOL_VERSION || (suppliedVersion !== null && suppliedVersion !== MCP_PROTOCOL_VERSION)) {
    return await handleModernMcpRpc(request, rpc, params, id ?? null, hasId);
  }
  const protocolHeaderError = validateProtocolVersionHeader(method, suppliedVersion);
  if (protocolHeaderError) return reply(400, rpcError(id ?? null, -32600, protocolHeaderError));

  if (method === "initialize") {
    if (!hasId) return reply(400, rpcError(null, -32600, "initialize must be a request."));
    if (typeof params.protocolVersion !== "string") return reply(400, rpcError(id, -32602, "initialize requires params.protocolVersion."));
    // Do not write to the database for unauthenticated initialization. The
    // opaque 256-bit capability is persisted only when the client attempts to
    // redeem a valid group invitation, preventing init-only request floods from
    // growing the session table.
    const sessionId = newSessionId();
    return reply(200, rpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "rub-minds", version: "0.1.0" },
      instructions: "Use join_group with a valid invitation and explicit confirmation. Session imports are private by default; group memory is shared only when visibility is explicitly set to group.",
    }), sessionId);
  }

  const sessionId = request.headers.get("Mcp-Session-Id") || "";
  if (!/^[a-f0-9]{64}$/.test(sessionId)) return httpError(404, "MCP session missing or invalid. Reconnect the Rub Minds MCP server.");

  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return hasId ? reply(200, rpcError(id, -32600, "Notifications must not include an id.")) : new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
  }
  if (!hasId) return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });

  if (method === "ping") return reply(200, rpcResult(id, {}), sessionId);
  if (method === "tools/list") return reply(200, rpcResult(id, { tools: RUB_MINDS_MCP_TOOLS }), sessionId);
  if (method !== "tools/call") return reply(200, rpcError(id, -32601, "Method not found."), sessionId);

  const toolName = params.name;
  const args = params.arguments === undefined ? {} : params.arguments;
  if (typeof toolName !== "string") return reply(200, rpcError(id, -32602, "Tool name is required."), sessionId);
  let session: Record<string, unknown> | null = await findSession(sessionId);
  if (!session) {
    if (toolName !== "join_group") return httpError(404, "MCP session missing, expired, or invalid. Reconnect and join with a valid invitation.");
    const sessionDigest = await sha256(sessionId);
    const { data: priorSession, error: lookupError } = await db.from("rub_minds_mcp_sessions")
      .select("session_digest")
      .eq("session_digest", sessionDigest)
      .maybeSingle();
    if (lookupError) return httpError(503, "Could not verify the MCP session before joining.");
    if (priorSession) return httpError(404, "MCP session expired or invalid. Reconnect the Rub Minds MCP server.");
    // Keep the not-yet-joined session in memory only. An invalid invite must not
    // create a persistent row; runTool persists it only after redemption succeeds.
    session = {
      session_digest: sessionDigest,
      agent_credential_ciphertext: null,
      room_id: null,
      participant_id: null,
      _new_session: true,
    };
  }
  if (session._new_session !== true) {
    try {
      if (!await consumeSessionRateLimit(session)) return reply(429, rpcError(id, -32000, "MCP session rate limit exceeded: 60 tool calls per minute. Wait briefly and retry."), sessionId);
    } catch {
      return reply(503, rpcError(id, -32000, "MCP session rate limiter is unavailable; request blocked."), sessionId);
    }
  }
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
}

Deno.serve(async (request: Request) => {
  const response = await handleMcpRequest(request);
  return applyMcpCors(response, request.headers.get("Origin"));
});
