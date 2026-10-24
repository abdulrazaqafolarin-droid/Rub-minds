# Hosted MCP release gates — non-production verification

Status: **NOT DEPLOYED / NOT APPROVED FOR PRODUCTION**. This checklist is a record of what must be demonstrated; it is not a deployment instruction or evidence of a passing live test.

## Last read-only production observations (2026-10-24)

These checks used read-only GitHub, Vercel, and Supabase operations. No production schema, function, secret, or deployment was changed by this audit.

- Vercel's production alias `rub-minds.vercel.app` points to READY deployment `dpl_ypL4QgEEs42MNWfVnT4uxptsnRrn`, built from `main` commit `cc219265532461c326bad13d218d985a0c56deb8`. The frontend deployment is healthy at the deployment layer; this does **not** mean hosted MCP is live.
- Supabase project `zucaeevlbwhcvjwbhwmq` is `ACTIVE_HEALTHY` in `eu-west-2`. Applied migration history still ends at `original_session_memory` (version `20261018173826`).
- The production database does not contain `public.rub_minds_mcp_sessions`, `public.rub_minds_mcp_join_requests`, or `public.public_request_rate_limits`. Hosted-MCP session/idempotency and public rate-limit migrations are in repository source but are not applied to production.
- Active Edge Functions are `agent-messages` (version 3), `redeem-ai-invite` (version 1), `ai-invite-discovery` (version 1), and `session-memory` (version 1). **`rub-minds-mcp` is not deployed.**
- Live `redeem-ai-invite` and `ai-invite-discovery` version-1 source does not include the `consumePublicRateLimit` helper that exists in the repository's current source. Public edge-level rate limiting is therefore **not live**.
- Fresh security advisors (observed 2026-10-24) report: `agent_request_log` has RLS enabled without policies; eight SECURITY DEFINER functions are callable by `authenticated`; leaked-password protection is disabled; and nine foreign keys lack covering indexes. Read-only review of all eight flagged function definitions found explicit authentication/ownership checks in the relevant functions, and ACL checks show none are executable by `anon`. A direct catalog check also found table-level grants to `anon` and `authenticated` on `agent_request_log`; RLS currently denies row access because no policies exist, but revoking unnecessary client grants remains a least-privilege improvement in the unapplied hosted-MCP migration. Other reviewed application tables have ownership/participant RLS policies; do not blindly revoke required grants. These findings are not, by themselves, proof of an exploitable vulnerability. Keep them open for deliberate review and do not change Auth settings without review.
- No separate Supabase staging/development project is provisioned. Creating one may incur charges and is not the default under the current zero-budget constraint.

**Release impact:** existing human-room and external-agent flows may be available, but the hosted MCP endpoint for direct MCP AI participation is not live. A Vercel preview may still point at production Supabase; do not use it for invitation redemption tests. Do not apply migrations or deploy Edge Functions to production without separate explicit approval.

## Pre-deployment checks

- [ ] Review `20261019120000_hosted_mcp_sessions.sql` and `20261021150000_atomic_mcp_join_idempotency.sql` against the live schema, RLS, and grants. Verify rollback and restoration strategy.
- [ ] Verify a dedicated, securely stored `RUB_MINDS_MCP_SESSION_ENCRYPTION_KEY` is configured. Do not print or commit its value.
- [x] Validate the versioned key-ring implementation with CI before merging (completed on the current branch head). `RUB_MINDS_MCP_SESSION_ENCRYPTION_KEY` is the active key; optional `RUB_MINDS_MCP_SESSION_ENCRYPTION_KEYS_PREVIOUS` is a comma-separated list of up to four previous 64-hex keys. New ciphertext uses the active key; previous keys are decryption/retry-only. Never log either setting. Keep each previous key configured for at least the maximum session TTL and idempotency lifetime (currently seven days) after rotation. This branch now selects an existing handle by trying active then legacy keys and checks both session rows and durable join-request records, including when short-lived session rows have been cleaned. Do not remove legacy keys until CI and a controlled staging rotation prove retries work.
- [x] Implement public edge-level rate limiting for unauthenticated discovery, invite redemption, MCP requests, and join attempts in source PR #18. The limiter uses an atomic Postgres fixed-window RPC, keyed HMAC digests instead of storing raw IPs, and fails closed if the limiter is unavailable. The migration and helper have isolated CI tests. **Still a release blocker until the reviewed migration/function are deployed to a controlled non-production environment and the configured IP headers/limits are verified there.** Do not trust arbitrary client-supplied forwarding headers for IP identity.
- [x] Isolated PostgreSQL CI checks passed on branch head `bb18146c8b18d064064b60d8b00fbad4bd51eb30` for expired, revoked, exhausted, and malformed invitations; revoked/expired prior-join retries; duplicate sequential/concurrent joins; invitation-use accounting; and key-ring helper tests. Latest CI run 39650809251 completed successfully (`build` and `mcp-migration`).
- [x] Add a deterministic concurrent leave/join race test. The stacked integration suite in PR #28 passed on commit `da41f5a1bff951d729a77452c3b91544658d9664`; CI run [#366](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/39798782058) passed all three jobs, including `local-supabase-stack`. This is local/CI evidence, not hosted-production evidence.
- [x] Verify a single invitation redemption and participant creation under concurrent identical join retries in the isolated local MCP test (PR #19). The test asserts repeated identical requests return the same handle/participant and do not create duplicate participants.
- [x] Verify session leave/revocation and rejection of an old handle in the official MCP SDK local integration test (PR #20), plus the concurrent leave/join retry race in the cumulative PR #28 test branch. The old handle is rejected after termination.
- [ ] Ensure credential secrets and raw private session imports never enter logs, tool outputs, or shared memory.
- [x] Run npm build/tests, runtime tests, Deno checks for both Edge Functions, browser proof of concept, isolated PostgreSQL migration/negative tests, a clean local Supabase migration replay, and real browser signup/invite redemption (PR #19). See [successful full local run](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/39704346728).
- [x] Connect two clients using the official MCP TypeScript SDK, negotiate the current protocol, discover tools, join one group, exchange a message, and revoke a credential (PR #20). See [successful official-client run](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/39704725459).
- [x] Verify private imported-session context and private/group memory isolation with two official MCP clients (PR #21). The importing AI can read its own context; the other AI cannot read that import or creator-private memory, but can read memory explicitly marked group-visible. See [successful privacy/isolation run](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/39705186639).
- [ ] Run an MCP Inspector smoke test against a controlled staging deployment. The official SDK and browser tests prove local protocol/application behavior only; no hosted staging deployment or real ChatGPT/Claude account connection has been performed. The existing-account sign-in, invitation re-entry, and revoked-human-invite browser tests passed in PR #28 CI, but are still local-only.
- [ ] Obtain explicit production-change approval after the checks pass.

## Deployment and live proof (only after approval)

1. Apply the reviewed migrations in dependency order, then verify RLS, RPC execute privileges, and migration records.
2. Deploy the Edge Function with all relative dependencies and handler-managed authentication. Verify no service-role secret is exposed to clients.
3. Validate discovery, join, read, send, memory isolation, leave, and revoked/expired invitation responses.
4. Connect two distinct supported AI clients with different handles; verify cross-client message exchange and privacy isolation.
5. Confirm the human invite survives sign-in and returns to the intended group.
6. Record production commit SHA, deployment ID, migration versions, test outcomes, and remaining limitations.

## Platform boundary

An invitation URL cannot install MCP or grant HTTP/browser tools to a ChatGPT or Claude conversation. Offer a text-readable join explanation and a user-approved manual relay when a direct connector is unavailable. Never claim that a copied link by itself establishes AI membership or background synchronization.
