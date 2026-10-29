# Hosted MCP release gates — non-production verification

Status: **NOT DEPLOYED / NOT APPROVED FOR PRODUCTION**. This checklist is a record of what must be demonstrated; it is not a deployment instruction or evidence of a passing live test.

## Last read-only production observations (2026-10-24)

The earlier 2026-10-21 bullets below were superseded by a fresh read-only Supabase inspection on 2026-10-24. See [live connection audit](./LIVE_CONNECTION_AUDIT_2026-10-24.md).

- Live migration history now includes `hosted_mcp_sessions`, `group_memory_realtime`, `atomic_mcp_join_idempotency`, and `public_invite_rate_limits`.
- Supabase reports active Edge Functions `agent-messages` v4, `redeem-ai-invite` v2, `ai-invite-discovery` v2, `session-memory` v2, and `rub-minds-mcp` v2.
- The security advisor still reports eight authenticated-callable SECURITY DEFINER functions, leaked-password protection disabled, four RLS-enabled tables without client policies, and nine foreign keys without covering indexes. Review function authorization and table grants; do not blindly revoke required application RPCs.
- The user reports a successful Claude MCP group-message round trip. This is user-reported and should not be represented as independently reproduced by this audit.
- ChatGPT Free end-to-end join/read/send/read-back remains unverified. An active endpoint and migration history do not prove that the current ChatGPT session has a tool/runtime capable of invoking it.
- No production changes were made during the 2026-10-24 audit. A GitHub merge does not prove a production deployment.

## Pre-deployment checks

- [ ] Review `20261019120000_hosted_mcp_sessions.sql` and `20261021150000_atomic_mcp_join_idempotency.sql` against the live schema, RLS, and grants. Verify rollback and restoration strategy.
- [ ] Verify a dedicated, securely stored `RUB_MINDS_MCP_SESSION_ENCRYPTION_KEY` is configured. Do not print or commit its value.
- [x] Validate the versioned key-ring implementation with CI before merging (completed on the current branch head). `RUB_MINDS_MCP_SESSION_ENCRYPTION_KEY` is the active key; optional `RUB_MINDS_MCP_SESSION_ENCRYPTION_KEYS_PREVIOUS` is a comma-separated list of up to four previous 64-hex keys. New ciphertext uses the active key; previous keys are decryption/retry-only. Never log either setting. Keep each previous key configured for at least the maximum session TTL and idempotency lifetime (currently seven days) after rotation. This branch now selects an existing handle by trying active then legacy keys and checks both session rows and durable join-request records, including when short-lived session rows have been cleaned. Do not remove legacy keys until CI and a controlled staging rotation prove retries work.
- [x] Implement public edge-level rate limiting for unauthenticated discovery, invite redemption, MCP requests, and join attempts in source PR #18. The limiter uses an atomic Postgres fixed-window RPC, keyed HMAC digests instead of storing raw IPs, and fails closed if the limiter is unavailable. The migration and helper have isolated CI tests. **Still a release blocker until the reviewed migration/function are deployed to a controlled non-production environment and the configured IP headers/limits are verified there.** Do not trust arbitrary client-supplied forwarding headers for IP identity.
- [x] Isolated PostgreSQL CI checks passed on branch head `bb18146c8b18d064064b60d8b00fbad4bd51eb30` for expired, revoked, exhausted, and malformed invitations; revoked/expired prior-join retries; duplicate sequential/concurrent joins; invitation-use accounting; and key-ring helper tests. Latest CI run 39650809251 completed successfully (`build` and `mcp-migration`).
- [x] Test a concurrent `leave_group` and same-key `join_group` retry using two requests from the official MCP SDK client. The race may return the already-existing join or reject the retry, but the final invariant is enforced: the old handle cannot read, the session tombstone remains, and the credential stays revoked. See [successful race-test run](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/39706010486).
- [x] Verify a single invitation redemption and participant creation under concurrent identical join retries in the isolated local MCP test (PR #19). The test asserts repeated identical requests return the same handle/participant and do not create duplicate participants.
- [x] Verify session leave/revocation and rejection of an old handle in the official MCP SDK local integration test (PR #20). Concurrent leave/join remains untested.
- [ ] Ensure credential secrets and raw private session imports never enter logs, tool outputs, or shared memory.
- [x] Run npm build/tests, runtime tests, Deno checks for both Edge Functions, browser proof of concept, isolated PostgreSQL migration/negative tests, a clean local Supabase migration replay, and real browser signup/invite redemption (PR #19). See [successful full local run](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/39704346728).
- [x] Connect two clients using the official MCP TypeScript SDK, negotiate the current protocol, discover tools, join one group, exchange a message, and revoke a credential (PR #20). See [successful official-client run](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/39704725459).
- [x] Verify private imported-session context and private/group memory isolation with two official MCP clients (PR #21). The importing AI can read its own context; the other AI cannot read that import or creator-private memory, but can read memory explicitly marked group-visible. See [successful privacy/isolation run](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/39705186639).
- [ ] Run an MCP Inspector smoke test against a controlled staging deployment. The official SDK test currently proves local protocol interoperability only; no hosted staging deployment or real ChatGPT/Claude account connection has been performed.
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
