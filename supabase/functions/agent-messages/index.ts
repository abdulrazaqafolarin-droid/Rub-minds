import { createClient } from "npm:@supabase/supabase-js@2";

const databaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!databaseUrl || !serviceKey) throw new Error("Missing backend configuration");
const db = createClient(databaseUrl, serviceKey, { auth: { persistSession: false } });

Deno.serve(async (request: Request) => {
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
  if (request.method !== "GET" && request.method !== "POST") return reply(405, { error: "Method not allowed" });
  const bearer = request.headers.get("Authorization") || "";
  if (!/^Bearer [0-9a-f]{64}$/.test(bearer)) return reply(401, { error: "Valid agent token required" });
  const secret = bearer.slice(7);
  let operation = "read";
  let payload: string | null = null;
  let sourceMessageId: string | null = null;
  if (request.method === "POST") {
    if (Number(request.headers.get("content-length") || "0") > 20000) return reply(413, { error: "Request too large" });
    let input: unknown;
    try { input = await request.json(); } catch { return reply(400, { error: "Invalid JSON" }); }
    if (!input || typeof input !== "object") return reply(400, { error: "Expected a JSON object" });
    const candidate = "operation" in input ? input.operation : "send";
    if (candidate !== "send" && candidate !== "heartbeat" && candidate !== "disconnect") {
      return reply(400, { error: "Operation must be send, heartbeat, or disconnect" });
    }
    operation = candidate as string;
    if (operation === "send") {
      if (!("body" in input) || typeof input.body !== "string") {
        return reply(400, { error: "Expected { operation: \"send\", body: string }" });
      }
      payload = input.body;
      if (payload.trim().length < 1 || payload.length > 10000) return reply(400, { error: "Message must be 1-10000 characters" });
      if ("source_message_id" in input) {
        if (typeof input.source_message_id !== "string" || input.source_message_id.length < 1 || input.source_message_id.length > 200) {
          return reply(400, { error: "source_message_id must be a 1-200 character string" });
        }
        sourceMessageId = input.source_message_id;
      }
    }
  }
  const { data, error } = await db.rpc("agent_exchange", {
    agent_secret: secret, operation, payload, source_message_id: sourceMessageId,
  });
  if (error) {
    if (error.message?.includes("Agent request limit exceeded")) {
      return new Response(JSON.stringify({ error: "Rate limit exceeded. Retry after one minute." }), { status: 429, headers: { ...headers, "Retry-After": "60" } });
    }
    return reply(401, { error: "Credential invalid or operation rejected" });
  }

  // Enrich room messages with safe participant metadata so runtimes can respond
  // to human messages only and avoid agent-to-agent feedback loops.
  if (request.method === "GET" && data && typeof data === "object" && Array.isArray(data.messages)) {
    const ids = [...new Set(data.messages.map((message: { sender_id?: string }) => message.sender_id).filter((id: unknown): id is string => typeof id === "string"))];
    if (ids.length) {
      const { data: participants, error: participantError } = await db
        .from("participants").select("id,display_name,kind").in("id", ids);
      if (participantError) return reply(500, { error: "Could not resolve message participants" });
      const byId = new Map((participants || []).map((participant: { id: string; display_name: string; kind: string }) => [participant.id, participant]));
      data.messages = data.messages.map((message: { sender_id: string }) => {
        const participant = byId.get(message.sender_id);
        return {
          ...message,
          sender_name: participant?.display_name || "Participant",
          sender_kind: participant?.kind || "unknown",
        };
      });
    }
  }
  return reply(200, data);
});
