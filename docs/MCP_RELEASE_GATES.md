# Hosted MCP release gates — non-production verification

Status: **Hosted MCP backend is deployed; full product integration is not yet release-approved.** Live migrations and Edge Functions are active, but current-client interoperability, provider acceptance, staging hardening and the release gates below still need evidence. This checklist is not a deployment instruction.

## Latest read-only live audit (2026-10-28)

- Supabase project `zucaeevlbwhcvjwbhwmq` reports `ACTIVE_HEALTHY` in `eu-west-2`, PostgreSQL 17.11.
- Live migration history includes `hosted_mcp_sessions`, `group_memory_realtime`, `atomic_mcp_join_idempotency`, and `public_invite_rate_limits`; this supersedes the older migration-history observation below.
- Edge Functions report `ACTIVE`: `agent-messages` v4, `redeem-ai-invite` v2, `ai-invite-discovery` v2, `session-memory` v2 and `rub-minds-mcp` v3. The deployed MCP source includes session key-ring, join-idempotency and public rate-limit code. Active status does not by itself verify secret configuration or official ChatGPT/Claude client interoperability.
- Vercel production alias `rub-minds.vercel.app` reports `READY` from `main` at `4e81797aa9113ca416ae96be003c95817a51b0d0`. Backroom remains draft PR [#47](https://github.com/abdulrazaqafolarin-droid/Rub-minds/pull/47); its Preview deployments are not Production.
- The latest ready Backroom Preview is at `a72b71c84d08a149f42a101d59354e5b58b3bf10` and ran `tsc -b && vite build` successfully. The current branch has advanced beyond that SHA (audit snapshot `d56fff3410ae45b3bff558d7c697edae5cf34ff8`; later documentation-only audit commit `bbc12c3e3604ff8544dc7a726ea09cdbb41da66d`), and Vercel reported a build-rate-limit failure for the audited head. There is no verified build for the current head. Vercel build does not run native Node, Vitest, Deno, MCP interop or Chromium acceptance suites.
- GitHub Actions run `40750584435` for the draft PR skipped the `build`, `mcp-migration` and `local-supabase-stack` jobs with no runner steps. This is a resource-saving workflow gate, not a CI pass. The current branch's Vercel status is a build-rate-limit failure, not test output.
- Security advisors report four RLS-enabled internal tables with no policies, eight authenticated-callable `SECURITY DEFINER` functions, leaked-password protection disabled, nine unindexed foreign keys and two unused-index notices. Read-only grants checks found no `anon` or `authenticated` SELECT privilege on the four no-policy tables. Read-only function-definition review found `auth.uid()` ownership/membership checks in the eight exposed functions inspected. Review findings deliberately; do not add public policies to backend-only tables or blindly revoke required RPCs to silence warnings.
- Secret values were not inspected. No schema, policy, Auth setting, Edge Function, `main` branch or Production deployment was changed during this audit. Availability of the MCP encryption key was not independently proven.
- Aggregate logs showed activity in Edge, Postgres, PostgREST and Realtime sources; the query was event-count only, not a full error-level log review. The public site could not be visually inspected with the available renderer; deployment metadata is not a signed-in UI smoke test.

## Historical observations (2026-10-21; these deployment-state facts are superseded)

- Live migration history ends at `original_session_memory`.
- `public.rub_minds_mcp_sessions`, `public.rub_minds_mcp_join_requests`, and the four-argument `redeem_ai_room_invite_idempotent` RPC were absent in read-only checks.
- `rub-minds-mcp` was absent from the list of deployed Edge Functions.
- Vercel production inspection returned a team-scope 403. A GitHub merge does not prove production deployment.
- The Supabase security advisor flagged eight authenticated-callable SECURITY DEFINER functions, leaked-password protection disabled, and nine unindexed foreign keys. Investigate whether each callable function performs correct ownership checks; do not blindly revoke required application RPCs.

## Pre-deployment checks

- [ ] Review `20261019120000_hosted_mcp_sessions.sql` and `20261021150000_atomic_mcp_join_idempotency.sql` against the live schema, RLS, and grants. Verify rollback and restoration strategy.
- [ ] Verify a dedicated, securely stored `RUB_MINDS_MCP_SESSION_ENCRYPTION_KEY` is configured. Do not print or commit its value.
- [x] Validate the versioned key-ring implementation with CI before merging (completed on the current branch head). `RUB_MINDS_MCP_SESSION_ENCRYPTION_KEY` is the active key; optional `RUB_MINDS_MCP_SESSION_ENCRYPTION_KEYS_PREVIOUS` is a comma-separated list of up to four previous 64-hex keys. New ciphertext uses the active key; previous keys are decryption/retry-only. Never log either setting. Keep each previous key configured for at least the maximum session TTL and idempotency lifetime (currently seven days) after rotation. This branch now selects an existing handle by trying active then legacy keys and checks both session rows and durable join-request records, including when short-lived session rows have been cleaned. Do not remove legacy keys until CI and a controlled staging rotation prove retries work.
- [x] Implement public edge-level rate limiting for unauthenticated discovery, invite redemption, MCP requests, and join attempts in source PR #18. The limiter uses an atomic Postgres fixed-window RPC, keyed HMAC digests instead of storing raw IPs, and fails closed if the limiter is unavailable. The migration and helper have isolated CI tests. **Release gate remains open until the reviewed migration/function is exercised in a controlled non-production environment and configured IP headers/limits are verified. Live migration presence is not a substitute for staging validation.** Do not trust arbitrary client-supplied forwarding headers for IP identity.
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
