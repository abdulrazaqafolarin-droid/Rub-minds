# Hosted MCP release gates — live production verification

Status: **BACKEND DEPLOYED; REAL PROVIDER CONNECTION STILL UNVERIFIED**. The MCP Edge Function is active in production and the required hosted-MCP migrations are present. This does not yet prove a real ChatGPT or Claude conversation has connected and participated in a group.

## Latest production observations (2026-10-24)

Independently checked through the connected Supabase project metadata:
- Project: `zucaeevlbwhcvjwbhwmq` (production, `eu-west-2`).
- `rub-minds-mcp` is ACTIVE at Edge Function version 2.
- `redeem-ai-invite` is ACTIVE at version 2.
- `ai-invite-discovery` is ACTIVE at version 2.
- `agent-messages` is ACTIVE at version 4; `session-memory` is ACTIVE at version 2.
- Migration history includes `hosted_mcp_sessions`, `group_memory_realtime`, `atomic_mcp_join_idempotency`, and `public_invite_rate_limits` (versions `20261024002156`, `20261024002200`, `20261024002204`, `20261024002207`).

OpenCode reports that it added the missing `RUB_MINDS_MCP_SESSION_ENCRYPTION_KEY` secret without printing its value and then observed successful MCP initialization/tool discovery and authorized disposable-fixture join/read/send/leave/revocation tests. Independently, a read-only query of Supabase request logs for the last 12 hours shows 12 HTTP 200 responses and one HTTP 202 from `rub-minds-mcp` version 2, alongside expected negative-path statuses (400, 403, 404, 405, 415). The eight HTTP 500 responses in that window came from version 1 before the fix. This corroborates live v2 HTTP activity, but logs alone do not prove each successful response was a real provider conversation or prove background sync. No key value belongs in this repository or any report.

Important distinction:
- **Backend availability:** deployed function/migrations confirmed; OpenCode reports successful live protocol and disposable-fixture tests.
- **MCP interoperability:** local official-SDK tests are reported passing.
- **Real provider integration:** not yet proven. No real Claude Free or ChatGPT Free conversation has been observed joining and exchanging a message with a human.
- **Background sync:** not proven. A request-triggered conversation/tool call does not imply the host will wake an idle chat when new group messages arrive.

Earlier observations in this PR that claimed the function was still v1, that invitation handlers were stale v1, or that the key was definitely still missing are superseded by the current read-only function inventory. Do not infer HTTP health solely from the ACTIVE status.

## Security review notes

- **Confirmed production security gap:** although the public invite rate-limit migration is present and `main` contains the shared limiter, the deployed source for `redeem-ai-invite` v2 and `ai-invite-discovery` v2 does not import or call `consumePublicRateLimit`. Their current deployed versions therefore lack the intended edge-level public rate limiting. The `rub-minds-mcp` v2 source does invoke the limiter. Do not mark invite-path abuse protection complete until the reviewed main handlers are deployed and live limiter behavior is verified.
- The Supabase security advisor previously flagged authenticated-callable SECURITY DEFINER functions, leaked-password protection, and unindexed foreign keys. Investigate each item in context; do not apply blanket grants/revocations or schema changes.
- No paid staging project should be created. Use local/isolated tests and carefully scoped disposable production fixtures only where necessary.
- Preserve the active encryption key. Do not rotate or replace it casually: doing so can make existing encrypted session bindings unreadable. Confirm secure backup/recovery without printing or committing the value.
- OpenCode reported that temporary secret-bearing files were deleted, but earlier notes were inconsistent about whether a key backup existed. Resolve the backup/recovery question securely before any rotation. If a Supabase personal access token was exposed in an unsafe place, rotate it through the provider's supported UI; never paste it into chat.

## Remaining release blockers

1. **Complete protocol verification from a supported MCP client.** Production request logs now corroborate successful v2 HTTP responses and expected negative-path behavior. Still verify the tool list and a full initialize/discovery flow with an approved client, without printing or persisting any bearer credential.
2. **Exercise the supported host connection path.** Claude Free currently documents custom remote MCP connectors, so test that path first. Configure the connector manually in the user's Claude account, then verify tool discovery and one disposable invite join. ChatGPT Free does not currently document the custom write-capable MCP path required for live group participation.
3. **Prove a real group round trip.** Using a dedicated, low-use test invitation, join from the connected AI, read group context/messages, send a clearly labeled test message, confirm a human can see it, then leave/revoke and verify the handle is rejected.
4. **Restore deployed invite-path rate limiting before broad exposure.** Live source inspection confirms `redeem-ai-invite` v2 and `ai-invite-discovery` v2 do not invoke the limiter even though the migration and main-branch implementation exist. First run the existing handler/limiter tests against the exact source bundle; then, only after explicit production-change approval, deploy the reviewed functions and verify rate-limit thresholds and fail-closed behavior using disposable fixtures.
5. **Document provider limits accurately.** Native context preservation is limited to the conversation's context window and what the AI explicitly imports; automatic history extraction, persistent background wake, and continuous two-way sync remain unproven.

## Evidence and its limits

- OpenCode reports 60 passing targeted tests across MCP, runtime, rate limiting, discovery, portable tools, and Playwright/session-bridge modules. Vitest was unavailable because its local dependencies were incomplete; the reported Node/Deno test suites passed.
- OpenCode reports successful live MCP initialize/tool discovery and authorized disposable-fixture join/read/send/leave/revocation tests after the encryption-key secret was configured.
- The connected Supabase inventory independently confirms the MCP Edge Function is ACTIVE v2 and the four hosted-MCP migrations are recorded in production.
- Official MCP TypeScript SDK local tests and local privacy/isolation/concurrency tests are recorded in prior CI runs. These prove local protocol/application behavior, not a connection from Claude or ChatGPT.
- No actual Claude Free or ChatGPT Free session has yet been demonstrated joining a room and exchanging a message with a human. That remains the primary milestone.

## Next verification checklist

- [ ] Confirm secure recovery/backup of the existing encryption key without revealing its value.
- [ ] Run an independent live initialize and tool-discovery request using an approved MCP client.
- [ ] Connect Claude Free to the remote MCP endpoint using the documented custom connector UI; verify the eight expected tools appear.
- [ ] Redeem only a disposable AI-enabled invite, read group context, send one test message, verify it as a human, leave, and confirm revocation.
- [ ] Verify invalid/expired/revoked invitation rejection with isolated fixtures.
- [ ] Keep `redeem-ai-invite` and `ai-invite-discovery` rate limiting marked BLOCKED until reviewed handler versions are deployed and a live over-limit/fail-closed test passes.
- [ ] Record exact client/platform, tool list, protocol version, function versions, sanitized results, and limitations.
- [ ] Reassess ChatGPT Free only if a supported connection route is available; do not count manual copy/paste relay as autonomous participation.

## Safety and cost constraints

- No new paid services or staging project by default.
- Never expose the Supabase service-role key, MCP encryption key, invite credentials, or raw private session imports.
- Do not run real invite-redemption tests against production with a user's valuable invitation. Use a dedicated test invite with limited uses.
- Do not claim success until the live end-to-end test passes.
