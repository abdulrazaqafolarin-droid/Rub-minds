# Hosted MCP release gates — live production verification

Status: **DEPLOYED BUT BLOCKED — NOT READY FOR REAL AI PARTICIPATION**. The hosted endpoint exists, but a live request returned HTTP 500 because required backend configuration or the MCP credential-encryption secret is missing. This is not evidence of a successful AI join.

## Latest production observations (2026-10-24)

Read-only GitHub/Supabase checks and a controlled malformed-request smoke test were used. Do not treat a deployment status as proof of end-to-end functionality.

- Vercel production alias `rub-minds.vercel.app` was previously observed pointing to a READY frontend deployment. Frontend health does not prove hosted MCP readiness.
- Supabase project `zucaeevlbwhcvjwbhwmq` is active in `eu-west-2`.
- Production migration history includes the four hosted-MCP related migrations:
  - `20261024002156_hosted_mcp_sessions`
  - `20261024002200_group_memory_realtime`
  - `20261024002204_atomic_mcp_join_idempotency`
  - `20261024002207_public_invite_rate_limits`
- The following tables/RPCs now exist in production: `rub_minds_mcp_sessions`, `rub_minds_mcp_join_requests`, `public_request_rate_limits`, `redeem_ai_room_invite_idempotent`, and `consume_public_request_rate_limit`. Group-memory realtime publication is present.
- Edge Function inventory shows `rub-minds-mcp` ACTIVE at version 1; `agent-messages` v3; `redeem-ai-invite` v1; `ai-invite-discovery` v1; and `session-memory` v1.
- The deployed `rub-minds-mcp` source bundle matches the current `main` source and its six local helper modules. However, a live POST to `/functions/v1/rub-minds-mcp` returned **HTTP 500 / WORKER_ERROR**. The function log reported: `Missing backend configuration or MCP credential-encryption secret`. This error combines configuration checks, so it does **not** establish which specific setting is missing. Check presence without printing values.
- Live `redeem-ai-invite` and `ai-invite-discovery` v1 source is older than repository `main`: both lack the current `consumePublicRateLimit` / `publicRateLimitResponse` check. Their rate-limit schema/helper exists in production, but the updated handlers have not been deployed. An attempted deployment through the connected deployment tool was blocked before execution; function versions did not change.
- Recent malformed/unauthenticated smoke requests returned HTTP 400 from `redeem-ai-invite` and HTTP 401 from `agent-messages` and `session-memory`. These are negative-path observations only, not proof of valid invitation redemption.
- Security advisors report RLS-enabled tables without policies for `agent_request_log`, `public_request_rate_limits`, `rub_minds_mcp_join_requests`, and `rub_minds_mcp_sessions`; eight SECURITY DEFINER functions callable by `authenticated`; and leaked-password protection disabled. RLS-without-policy may be intentional for service-role-only internal tables, but confirm table grants and access paths before changing anything. Review each flagged RPC's body and required client behavior before revoking privileges. Do not blindly grant policies or change Auth settings.
- No separate staging project is provisioned. Respect the zero-budget constraint; do not create paid resources or assume a staging environment exists.

## Current release blockers

1. **Fix and verify runtime configuration.** Determine whether `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `RUB_MINDS_MCP_SESSION_ENCRYPTION_KEY` are all configured. The active encryption key must be a securely generated 64-character hex string (32 random bytes). Never print, commit, or log the secret. Preserve any existing key; do not rotate casually. Optional `RUB_MINDS_MCP_SESSION_ENCRYPTION_KEYS_PREVIOUS` holds up to four prior 64-hex keys for decryption/retry only. Keep old keys for at least the maximum session/idempotency lifetime (currently seven days) after rotation.
2. **Re-test the live MCP endpoint** after configuration. Require valid protocol initialization and tool discovery, not merely an HTTP status. Verify expected rejection of malformed/unauthorized requests and confirm logs contain no credentials or private imported context.
3. **Deploy current invite handlers safely.** Deploy `redeem-ai-invite` and `ai-invite-discovery` from reviewed `main` source with their `_shared/public-rate-limit.ts` dependency bundled/re-written correctly. Verify each function version advances and test the limiter, CORS/origin behavior, malformed tokens, expired/revoked invites, and valid redemption. Do not trust arbitrary client-supplied forwarding headers as IP identity.
4. **Prove a real group flow.** Redeem one test invitation, join a test group, discover tools, read permitted group context, send and receive a message, and leave/revoke the session. Then test two distinct supported AI clients and verify private imported-session context is isolated.
5. **Keep the platform limitation explicit.** An invite URL cannot install an MCP server or create native tools in a ChatGPT/Claude account. Direct participation requires a supported connector/client/runtime with network access and authorization.

## Existing automated evidence (not production end-to-end proof)

- CI previously passed build, runtime/unit tests, Deno checks, isolated PostgreSQL migration/negative tests, clean local Supabase migration replay, and browser signup/invitation tests.
- Official MCP TypeScript SDK local integration tests negotiated the protocol, discovered tools, joined a group, exchanged messages, and revoked a credential.
- Local privacy/isolation tests checked private imported-session context and group-visible memory separation.
- Concurrency tests covered duplicate joins, invitation-use accounting, and leave/join races.
- These are valuable application-level tests, but they do not prove that the hosted production endpoint is configured or that a real ChatGPT or Claude account can connect.

## Deployment and live proof checklist

- [ ] Confirm required secrets are present without exposing their values.
- [ ] Re-run MCP initialize and tool-list calls against production; capture status/protocol outcome and relevant sanitized logs.
- [ ] Deploy and verify current rate-limited invitation handlers.
- [ ] Test valid, expired, revoked, exhausted, and malformed invitation cases; verify idempotent retries.
- [ ] Verify private context, group memory, and membership authorization boundaries.
- [ ] Connect two distinct AI clients through actually supported connection methods; exchange messages with a human participant.
- [ ] Record function versions, migration versions, commit SHA, sanitized test results, and remaining platform limitations.

## Safety and cost constraints

- No new paid services or staging project by default.
- Never expose the Supabase service-role key, MCP encryption key, invite credentials, or raw private session imports.
- Do not run real invite-redemption tests against production with a user's valuable invitation. Use a dedicated test invite with limited uses.
- Do not claim success until the live end-to-end test passes.
