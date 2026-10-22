# Blocker 2 — hosted MCP staging readiness (read-only audit, 2026-10-22)

**Status: blocked pending a separate, explicitly approved staging environment. Do not run these migrations or deploy the MCP Edge Function against production as part of this work.**

## Evidence from the connected Rub Minds Supabase project

Project ref: `zucaeevlbwhcvjwbhwmq` (Rub Minds, active). The following were checked **read-only**:

- Applied migration history ends at `20261018173826_original_session_memory`.
- `public.rub_minds_mcp_sessions`: **absent**.
- `public.rub_minds_mcp_join_requests`: **absent**.
- `public.redeem_ai_room_invite_idempotent(text,text,text,text)`: **absent**.
- Edge Functions: `agent-messages`, `redeem-ai-invite`, `ai-invite-discovery`, `session-memory`. **No `rub-minds-mcp` function.**
- Supabase development branches: **none**.
- Existing `room_invites`, `participants`, `agent_connections`, `agent_request_log` tables have the expected base columns, but production has real foreign keys to `rooms` and `auth.users` not represented in the isolated PostgreSQL CI fixtures.
- `room_invites.max_ai_uses` has a 0–20 check; `participants.kind` allows `external_agent`; `participants.status` allows `waiting`; `agent_connections.credential_digest` is unique.

## What is verified

- PR #14 merged as `ab94b3acfd9b49ae3c96dd6fc8df587d05255986`.
- GitHub Actions main push run `39664295481` passed both `build` and `mcp-migration`.
- Isolated CI covers duplicate redemptions and multiple negative cases. It **does not** prove migrations or Edge Function work in a live Supabase staging project.

## Controlled staging acceptance plan

1. Obtain approval for a **separate non-production Supabase project or development branch**. Creating a branch may incur hourly compute charges; check and approve costs first. No production-data copy.
2. Apply `20261019120000_hosted_mcp_sessions.sql` followed by `20261021150000_atomic_mcp_join_idempotency.sql` in staging, verifying migration history, RLS, RPC execute privileges, and all foreign keys.
3. Configure a dedicated staging `RUB_MINDS_MCP_SESSION_ENCRYPTION_KEY` and staging-only Supabase credentials; never log secrets. Keep previous-key rotation tests isolated from production.
4. Implement and verify **trusted edge-level throttling for unauthenticated discovery and invalid join attempts** before publicly exposing the staging MCP endpoint. Per-session database throttling does not protect unauthenticated requests.
5. Deploy `rub-minds-mcp` to staging only. Use a protocol-compatible MCP client/Inspector to test initialize, tool listing, join, read, send, memory boundaries, leave, and rejected/revoked/expired invitations.
6. Verify two distinct supported AI clients exchange messages, idempotent retries consume one invite use, and no private session memory leaks across participants.
7. Verify human invite survives login/registration separately. Record commit SHA, staging function version, migration versions, test outcomes, and rollback plan.
8. Request **separate explicit production approval** only after staging and security gates pass.

## Remaining release blockers

- No staging backend currently provisioned.
- No trusted unauthenticated edge limiter currently provisioned.
- Deterministic concurrent leave/join race test is still needed.
- No MCP Inspector or two-client live integration proof.
- No production changes are authorized by this audit.

Do not treat a GitHub merge, a Vercel preview, or isolated PostgreSQL CI as proof of a live MCP deployment.
