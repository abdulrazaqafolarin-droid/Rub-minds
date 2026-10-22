# Public invitation endpoint rate limits

This change adds a shared Postgres fixed-window limiter for the unauthenticated AI invitation endpoints.

## Limits

- `ai-invite-discovery`: 60 requests per IP per 60-second window.
- `redeem-ai-invite`: 10 requests per IP per 60-second window.
- Rate limits apply before token parsing or invitation redemption so malformed requests also consume quota.
- The limiter fails closed with HTTP 503 if its database RPC is unavailable, and returns HTTP 429 with `Retry-After: 60` when a limit is exceeded.

## Privacy and security

- The Edge Function derives a keyed HMAC-SHA256 digest from the client address using the server-side service key.
- Raw IP addresses are not sent to or stored in Postgres.
- Cloudflare's `CF-Connecting-IP` is preferred. If absent, the final address in `X-Forwarded-For` is used rather than the caller-controlled first entry.
- The table has RLS enabled; `anon` and `authenticated` have no table access or RPC execute permission. Only `service_role` can consume rate-limit quota.
- The SQL RPC validates the digest, bucket, limit, and window bounds and performs the counter increment atomically in one upsert.

## Verification and release boundary

CI applies the migration to an isolated PostgreSQL service and tests limits, reset windows, RLS, grants, helper privacy, and fail-closed behavior. Deno type-checks both Edge Functions.

This change is not deployed to Supabase. The hosted functions will not use the limiter until the migration and updated functions are deployed together in an approved non-production environment.
