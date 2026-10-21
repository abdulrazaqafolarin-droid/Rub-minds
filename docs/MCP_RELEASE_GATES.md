# Hosted MCP release gates — non-production verification

Status: **NOT DEPLOYED / NOT APPROVED FOR PRODUCTION**. This checklist is a record of what must be demonstrated; it is not a deployment instruction or evidence of a passing live test.

## Current production observations (2026-10-21)

- Live migration history ends at `original_session_memory`.
- `public.rub_minds_mcp_sessions`, `public.rub_minds_mcp_join_requests`, and the four-argument `redeem_ai_room_invite_idempotent` RPC were absent in read-only checks.
- `rub-minds-mcp` was absent from the list of deployed Edge Functions.
- Vercel production inspection returned a team-scope 403. A GitHub merge does not prove production deployment.
- The Supabase security advisor flagged eight authenticated-callable SECURITY DEFINER functions, leaked-password protection disabled, and nine unindexed foreign keys. Investigate whether each callable function performs correct ownership checks; do not blindly revoke required application RPCs.

## Pre-deployment checks

- [ ] Review `20261019120000_hosted_mcp_sessions.sql` and `20261021150000_atomic_mcp_join_idempotency.sql` against the live schema, RLS, and grants. Verify rollback and restoration strategy.
- [ ] Verify a dedicated, securely stored `RUB_MINDS_MCP_SESSION_ENCRYPTION_KEY` is configured. Do not print or commit its value.
- [ ] Validate the new versioned key-ring implementation with CI before merging. `RUB_MINDS_MCP_SESSION_ENCRYPTION_KEY` is the active key; optional `RUB_MINDS_MCP_SESSION_ENCRYPTION_KEYS_PREVIOUS` is a comma-separated list of up to four previous 64-hex keys. New ciphertext uses the active key; previous keys are decryption/retry-only. Never log either setting. Keep each previous key configured for at least the maximum session TTL and idempotency lifetime (currently seven days) after rotation. This branch now selects an existing handle by trying active then legacy keys and checks both session rows and durable join-request records, including when short-lived session rows have been cleaned. Do not remove legacy keys until CI and a controlled staging rotation prove retries work.
- [ ] Add trusted edge-level rate limiting for unauthenticated discovery and invalid join attempts. Per-session DB rate limiting is insufficient for unauthenticated floods; the current MCP handler skips session-rate limiting for new join attempts. Do not trust arbitrary client-supplied forwarding headers for IP identity.
- [ ] CI now contains isolated PostgreSQL negative cases for expired, revoked, and exhausted invites. Verify these checks on the latest branch commit; still add malformed-token, prior-join-revoked/expired, and concurrent leave/join cases.
- [ ] Verify a single invitation redemption and participant creation under concurrent identical join retries.
- [ ] Verify session leave/revocation and rejection of old handles, including concurrent leave/join.
- [ ] Ensure credential secrets and raw private session imports never enter logs, tool outputs, or shared memory.
- [ ] Run tests, TypeScript/Edge Function checks, SQL fixture tests, and a protocol-compatible MCP Inspector smoke test.
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
