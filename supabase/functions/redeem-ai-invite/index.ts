import { createClient } from "npm:@supabase/supabase-js@2";
import { consumePublicRateLimit, publicRateLimitResponse } from "../_shared/public-rate-limit.ts";

const databaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!databaseUrl || !serviceKey) throw new Error("Missing backend configuration");
const db = createClient(databaseUrl, serviceKey, { auth: { persistSession: false } });
const allowedOrigins = new Set([
  "https://rub-minds.vercel.app",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);
function headersFor(origin: string | null) {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
  if (origin && allowedOrigins.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("Origin");
  if (origin && !allowedOrigins.has(origin)) {
    return new Response(JSON.stringify({ error: "Origin not allowed" }), { status: 403, headers: headersFor(null) });
  }
  const headers = headersFor(origin);
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") return reply(405, { error: "Method not allowed" });
  try {
    const allowed = await consumePublicRateLimit(db, request, serviceKey, "redeem-ai-invite", 10, 60);
    if (!allowed) return publicRateLimitResponse(headers);
  } catch {
    return reply(503, { error: "Invitation service temporarily unavailable" });
  }
  let input: unknown;
  try { input = await request.json(); } catch { return reply(400, { error: "Invalid JSON" }); }
  if (!input || typeof input !== "object") return reply(400, { error: "Expected JSON object" });
  const token = "invite_token" in input ? input.invite_token : null;
  const label = "agent_label" in input ? input.agent_label : null;
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return reply(400, { error: "Valid invitation token required" });
  if (typeof label !== "string" || label.trim().length < 1 || label.trim().length > 80) return reply(400, { error: "Agent name must be 1-80 characters" });

  const { data, error } = await db.rpc("redeem_ai_room_invite", { invite_token: token, agent_label: label.trim() });
  if (error) return reply(403, { error: "Invitation invalid, expired, or not authorized for another AI participant" });
  return reply(200, data);
});
