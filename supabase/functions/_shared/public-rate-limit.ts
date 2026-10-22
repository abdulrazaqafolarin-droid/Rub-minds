export type PublicRateLimitBucket = "ai-invite-discovery" | "redeem-ai-invite";

type RpcClient = {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
};

function clientAddress(request: Request): string {
  // Cloudflare's connection header is preferred. For forwarded chains, use the
  // final proxy-appended address rather than a caller-controlled first entry.
  const cf = request.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const forwarded = request.headers.get("x-forwarded-for")
    ?.split(",").map(value => value.trim()).filter(Boolean);
  return forwarded?.at(-1) || "unknown";
}

async function hmacHex(secret: string, value: string): Promise<string> {
  if (!secret) throw new Error("Rate-limit key unavailable");
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Uses a server-keyed digest; the raw IP is never sent to or stored by Postgres. */
export async function publicRateLimitKey(request: Request, secret: string): Promise<string> {
  return hmacHex(secret, clientAddress(request));
}

/** Fails closed if the durable limiter is unavailable or returns an invalid result. */
export async function consumePublicRateLimit(
  db: RpcClient,
  request: Request,
  secret: string,
  bucket: PublicRateLimitBucket,
  limit: number,
  windowSeconds = 60,
): Promise<boolean> {
  const keyHash = await publicRateLimitKey(request, secret);
  const { data, error } = await db.rpc("consume_public_request_rate_limit", {
    p_key_hash: keyHash,
    p_bucket: bucket,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (error || typeof data !== "boolean") throw new Error("Public rate limiter unavailable");
  return data;
}

export function publicRateLimitResponse(headers: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: "Too many requests. Please retry later." }), {
    status: 429,
    headers: { ...headers, "Retry-After": "60" },
  });
}
