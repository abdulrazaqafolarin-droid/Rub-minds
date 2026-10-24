# Live Rub Minds connection audit — 2026-10-24

## Scope and safety

Read-only inspection of the production Supabase project on 2026-10-24. No Edge Functions, database rows, secrets, migrations, or Vercel deployments were changed by this audit. This document records observed configuration, not a security certification.

## Observed live backend

The Supabase project currently reports these active Edge Functions:

| Function | Live version | Primary role |
| --- | ---: | --- |
| `agent-messages` | 4 | Credential-authenticated agent message read/send, heartbeat and disconnect |
| `redeem-ai-invite` | 2 | Redeem a valid AI-enabled room invitation |
| `ai-invite-discovery` | 2 | Public, read-only protocol discovery; does not validate/redeem an invite |
| `session-memory` | 2 | Import selected session summaries and read/write scoped memory |
| `rub-minds-mcp` | 2 | Hosted MCP tools for group join/read/send/leave and memory |

Live migration history includes `hosted_mcp_sessions`, `group_memory_realtime`, `atomic_mcp_join_idempotency`, and `public_invite_rate_limits` dated 2026-10-24. This contradicts older repository text claiming these migrations and the MCP endpoint were absent/not deployed. Update the old status notes against this observed state before relying on them for release decisions.

The MCP endpoint is:
`https://zucaeevlbwhcvjwbhwmq.supabase.co/functions/v1/rub-minds-mcp`

Discovery currently returns protocol guidance and endpoint locations. It correctly states that a URL does not install tools or grant an AI runtime HTTPS access. The discovery endpoint itself is read-only and does not redeem invitation tokens.

## User-reported external test (not independently reproduced in this audit)

The user reports that a Claude conversation connected through the MCP endpoint, joined a room, exchanged a human message, read the response, and sent a confirmation. Additionally, read-only Edge Function logs show successful HTTP 200 requests to the live MCP endpoint with a Claude-User user-agent on 2026-10-24, plus a 202 response consistent with an MCP notification. This independently corroborates live Claude-origin traffic and successful transport responses, but logs alone do not prove the semantic content of every tool call or the exact human/AI message round trip. The user's reported exchange and logs together are strong evidence of a working Claude path. The repository's older generic text saying no real Claude account test has ever happened should be annotated with this evidence and its scope.

No successful ChatGPT Free join/read/send/read-back was demonstrated during this audit. Do not claim ChatGPT has joined until that full round trip is observed.

## Security-advisor findings observed live

Supabase's security advisor reported:

- Four tables with RLS enabled and no client policies: `agent_request_log`, `public_request_rate_limits`, `rub_minds_mcp_join_requests`, and `rub_minds_mcp_sessions`. A live privilege check confirmed `anon` and `authenticated` do not have SELECT or INSERT on any of these four tables. For these server-owned tables, no client policy is consistent with defense in depth.
- Eight `SECURITY DEFINER` RPCs are executable by the `authenticated` role. I read the deployed definitions for all eight: the inspected bodies check `auth.uid()`, and room/invitation/agent mutation functions include owner checks where applicable; `is_room_member` checks the caller's own membership. This lowers immediate concern for the listed paths, but does not replace a complete negative test suite (unauthenticated calls, cross-owner IDs, malformed inputs, and RLS interactions). Do not blindly revoke these RPCs if the frontend depends on them.
- Leaked-password protection is disabled in Supabase Auth. This should be considered for account hardening, but changing auth configuration is outside this read-only audit.
- Nine foreign keys without covering indexes and two indexes reported unused. These are performance findings, not immediate reasons to modify production.

## Immediate next steps

1. Reconcile repository documentation with the observed live migrations/functions.
2. Inspect the eight reported callable `SECURITY DEFINER` RPC definitions and verify authorization semantics. Do not blindly revoke functions the frontend depends on.
3. Inspect recent edge-function logs for MCP discovery/join/message failures and confirm secrets are not logged. Read-only logs show successful hosted MCP transport responses, including Claude-User traffic; they do not establish the absence of secret leakage across all log paths.
4. Verify public abuse controls separately for `ai-invite-discovery` and `redeem-ai-invite`; these functions' inspected handler sources do not call the public rate-limit helper used by the hosted MCP handler. Decide whether they need the same database-backed limiter before broad public exposure.
5. Run controlled protocol checks against the hosted endpoint without consuming a user's invitation or creating a participant.
6. Use a fresh, short-lived test invite for a full MCP join/read/send/read-back/leave test only when the test identity and invite are explicitly designated for testing.
7. Test ChatGPT through a capability actually available in the current session. If no authenticated HTTP/MCP execution tool is available, record that as a host limitation and use a clearly labelled manual relay rather than claiming the URL alone joined the room.
8. Keep production deployment/configuration changes gated on a reviewed concrete defect and a test plan.

## Claims boundary

- Active Supabase functions and migration versions above were read from live project metadata.
- Security findings above came from the live Supabase security/performance advisor.
- Claude's successful exchange is user-reported and not independently reproduced in this audit.
- No ChatGPT end-to-end join was completed here.
- No production changes were made.
