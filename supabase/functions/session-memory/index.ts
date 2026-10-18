import { createClient } from "npm:@supabase/supabase-js@2";

const databaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!databaseUrl || !serviceKey) throw new Error("Missing backend configuration");
const db = createClient(databaseUrl, serviceKey, { auth: { persistSession: false } });

const allowedOrigins = new Set([
  "https://rub-minds.vercel.app",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);
const MAX_DOCUMENT_BYTES = 1024 * 1024;

function headersFor(origin: string | null) {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
  if (origin && allowedOrigins.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}
function reply(status: number, body: unknown, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers });
}
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort().map(key => JSON.stringify(key) + ":" + stableStringify(record[key])).join(",") + "}";
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}
async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
function validateDocument(value: unknown): { document: Record<string, unknown>; bytes: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const document = value as Record<string, unknown>;
  const serialized = stableStringify(document);
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > MAX_DOCUMENT_BYTES) return null;
  if (document.schema !== "rub-minds.session-memory" || document.version !== 1) return null;
  if (typeof document.summary !== "string" || document.summary.length > 20000) return null;
  if (typeof document.current_goal !== "string" || document.current_goal.length > 4000) return null;
  if (!document.source || typeof document.source !== "object" || Array.isArray(document.source)) return null;
  const source = document.source as Record<string, unknown>;
  if (typeof source.platform !== "string" || source.platform.trim().length < 1 || source.platform.length > 80) return null;
  if (document.sharing && typeof document.sharing === "object") {
    const sharing = document.sharing as Record<string, unknown>;
    if (sharing.raw_history_visibility !== undefined && sharing.raw_history_visibility !== "private") return null;
  }
  return { document, bytes };
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("Origin");
  if (origin && !allowedOrigins.has(origin)) {
    return reply(403, { error: "Origin not allowed" }, headersFor(null));
  }
  const headers = headersFor(origin);
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "GET" && request.method !== "POST") {
    return reply(405, { error: "Method not allowed" }, headers);
  }
  if (Number(request.headers.get("content-length") || "0") > MAX_DOCUMENT_BYTES + 65536) {
    return reply(413, { error: "Request too large" }, headers);
  }

  const authorization = request.headers.get("Authorization") || "";
  if (!/^Bearer [0-9a-f]{64}$/.test(authorization)) {
    return reply(401, { error: "Valid AI participant credential required" }, headers);
  }
  const secret = authorization.slice(7);
  const digest = await sha256(secret);
  const { data: connection, error: connectionError } = await db
    .from("agent_connections")
    .select("id, room_id, participant_id, owner_id, expires_at, revoked_at")
    .eq("credential_digest", digest)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (connectionError || !connection) {
    return reply(401, { error: "AI participant credential is invalid, expired, or revoked" }, headers);
  }

  // Validate the credential against the existing, rate-limited exchange RPC too.
  const { error: authError } = await db.rpc("agent_exchange", {
    agent_secret: secret,
    operation: "heartbeat",
    payload: null,
    source_message_id: null,
  });
  if (authError) {
    return reply(401, { error: "AI participant credential is invalid or rate limited" }, headers);
  }

  if (request.method === "POST") {
    let input: unknown;
    try { input = await request.json(); } catch { return reply(400, { error: "Invalid JSON" }, headers); }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return reply(400, { error: "Expected a JSON object" }, headers);
    }
    const record = input as Record<string, unknown>;
    if (record.operation === "remember") {
      const allowedTypes = new Set(["goal", "insight", "decision", "open_question", "progress", "summary"]);
      if (typeof record.entry_type !== "string" || !allowedTypes.has(record.entry_type)) {
        return reply(400, { error: "Invalid memory entry_type" }, headers);
      }
      if (record.visibility !== "private" && record.visibility !== "group") {
        return reply(400, { error: "visibility must explicitly be private or group" }, headers);
      }
      if (typeof record.content !== "string" || record.content.trim().length < 1 || record.content.length > 12000) {
        return reply(400, { error: "content must be 1-12000 characters" }, headers);
      }
      if (typeof record.idempotency_key !== "string" || record.idempotency_key.length < 8 || record.idempotency_key.length > 200) {
        return reply(400, { error: "idempotency_key must be 8-200 characters" }, headers);
      }
      let sourceMessageIds: string[] = [];
      if (record.source_message_ids !== undefined) {
        if (!Array.isArray(record.source_message_ids) || record.source_message_ids.length > 50 ||
          record.source_message_ids.some(id => typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
          return reply(400, { error: "source_message_ids must be an array of at most 50 UUIDs" }, headers);
        }
        sourceMessageIds = record.source_message_ids as string[];
      }
      let sourceImportId: string | null = null;
      if (record.source_import_id !== undefined && record.source_import_id !== null) {
        if (typeof record.source_import_id !== "string" || !/^[0-9a-f-]{36}$/i.test(record.source_import_id)) {
          return reply(400, { error: "source_import_id must be a UUID" }, headers);
        }
        const { data: sourceImport } = await db.from("room_session_imports")
          .select("id")
          .eq("id", record.source_import_id)
          .eq("room_id", connection.room_id)
          .eq("participant_id", connection.participant_id)
          .maybeSingle();
        if (!sourceImport) return reply(404, { error: "Session import not found for this participant" }, headers);
        sourceImportId = sourceImport.id;
      }
      const { data, error } = await db.from("room_memory_entries").insert({
        room_id: connection.room_id,
        source_import_id: sourceImportId,
        created_by_participant_id: connection.participant_id,
        owner_id: connection.owner_id,
        entry_type: record.entry_type,
        visibility: record.visibility,
        content: record.content.trim(),
        source_message_ids: sourceMessageIds,
        idempotency_key: record.idempotency_key,
      }).select("id, entry_type, visibility, content, source_message_ids, created_at").single();
      if (error || !data) {
        if (error?.code === "23505") return reply(409, { error: "Memory entry already recorded for this idempotency key" }, headers);
        return reply(500, { error: "Could not save memory entry. Ensure the session-memory migration is applied." }, headers);
      }
      return reply(201, { remembered: true, entry: data }, headers);
    }
    if (record.operation !== "import") {
      return reply(400, { error: "Operation must be import or remember" }, headers);
    }
    const validated = validateDocument(record.document);
    if (!validated) {
      return reply(400, {
        error: "Invalid session document. Expected version 1 and a document no larger than 1 MiB.",
      }, headers);
    }
    const document = validated.document;
    const source = document.source as Record<string, unknown>;
    const title = typeof source.session_label === "string" && source.session_label.trim()
      ? source.session_label.trim().slice(0, 160)
      : "Imported AI session";
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

    if (error || !data) {
      return reply(500, { error: "Could not save session import. Ensure the session-memory migration is applied." }, headers);
    }
    return reply(201, { imported: true, session: data }, headers);
  }

  const { data: imports, error: importsError } = await db
    .from("room_session_imports")
    .select("id, document_version, source_platform, title, context_summary, imported_context, content_sha256, created_at")
    .eq("room_id", connection.room_id)
    .eq("participant_id", connection.participant_id)
    .order("created_at", { ascending: false })
    .limit(10);
  if (importsError) return reply(500, { error: "Could not load session memory" }, headers);

  const { data: memory, error: memoryError } = await db
    .from("room_memory_entries")
    .select("id, entry_type, visibility, content, source_message_ids, created_at, updated_at")
    .eq("room_id", connection.room_id)
    .or("visibility.eq.group,created_by_participant_id.eq." + connection.participant_id)
    .order("updated_at", { ascending: false })
    .limit(100);
  if (memoryError) return reply(500, { error: "Could not load group memory" }, headers);

  return reply(200, {
    room_id: connection.room_id,
    participant_id: connection.participant_id,
    imports: imports || [],
    group_memory: memory || [],
  }, headers);
});
