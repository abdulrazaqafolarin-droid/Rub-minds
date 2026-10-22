import {
  consumePublicRateLimit,
  publicRateLimitKey,
  publicRateLimitResponse,
} from "./public-rate-limit.ts";

Deno.test("rate-limit key uses the trusted connection IP and never returns it verbatim", async () => {
  const request = new Request("https://example.test", {
    headers: {
      "cf-connecting-ip": "203.0.113.10",
      "x-forwarded-for": "198.51.100.77, 192.0.2.10",
    },
  });
  const key = await publicRateLimitKey(request, "test-only-server-secret");
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("Expected a 64-character lowercase digest");
  if (key.includes("203.0.113.10")) throw new Error("Raw IP leaked into rate-limit key");
  const other = await publicRateLimitKey(
    new Request("https://example.test", { headers: { "cf-connecting-ip": "203.0.113.11" } }),
    "test-only-server-secret",
  );
  if (key === other) throw new Error("Different IPs must produce different keys");
});

Deno.test("forwarded fallback selects the final proxy-appended address", async () => {
  const request = new Request("https://example.test", {
    headers: { "x-forwarded-for": "198.51.100.77, 192.0.2.10" },
  });
  const a = await publicRateLimitKey(request, "test-only-server-secret");
  const b = await publicRateLimitKey(
    new Request("https://example.test", { headers: { "x-real-ip": "192.0.2.10" } }),
    "test-only-server-secret",
  );
  if (a !== b) throw new Error("Forwarded chain should use the final address");
});

Deno.test("durable limiter sends only the digest and rejects after the limit", async () => {
  let received: Record<string, unknown> | undefined;
  const request = new Request("https://example.test", {
    headers: { "cf-connecting-ip": "203.0.113.25" },
  });
  const db = {
    async rpc(name: string, args: Record<string, unknown>) {
      if (name !== "consume_public_request_rate_limit") throw new Error("Unexpected RPC");
      received = args;
      return { data: false, error: null };
    },
  };
  const allowed = await consumePublicRateLimit(
    db, request, "test-only-server-secret", "redeem-ai-invite", 10, 60,
  );
  if (allowed !== false) throw new Error("Rate limit denial must be respected");
  if (received?.p_bucket !== "redeem-ai-invite" || received?.p_limit !== 10) {
    throw new Error("Wrong rate-limit parameters");
  }
  if (typeof received?.p_key_hash !== "string" || !/^[0-9a-f]{64}$/.test(received.p_key_hash)) {
    throw new Error("RPC must receive only a keyed digest");
  }
  if (JSON.stringify(received).includes("203.0.113.25")) throw new Error("Raw IP sent to database");
});

Deno.test("limiter errors fail closed", async () => {
  const db = { async rpc() { return { data: null, error: new Error("database unavailable") }; } };
  let threw = false;
  try {
    await consumePublicRateLimit(
      db, new Request("https://example.test"), "test-only-server-secret", "ai-invite-discovery", 60,
    );
  } catch (error) {
    threw = error instanceof Error && error.message === "Public rate limiter unavailable";
  }
  if (!threw) throw new Error("Limiter failure must fail closed");
});

Deno.test("429 response communicates retry timing without leaking request data", async () => {
  const response = publicRateLimitResponse({ "Content-Type": "application/json" });
  if (response.status !== 429 || response.headers.get("Retry-After") !== "60") {
    throw new Error("Expected HTTP 429 with Retry-After");
  }
  const body = await response.json();
  if (body.error !== "Too many requests. Please retry later.") throw new Error("Unexpected error response");
});
