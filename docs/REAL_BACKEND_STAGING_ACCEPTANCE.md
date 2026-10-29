# Real Backend and Release-Gate Snapshot

**Observed:** 2026-10-29 (UTC)  
**Scope:** Read-only inspection of the linked Supabase organization/project, deployed Edge Function inventory, migration history, security advisors, and sanitized request-log aggregates. This is not a provider end-to-end acceptance report.

## Guardrails observed

- No production database writes were performed.
- No migration or Edge Function was applied/deployed.
- No invites, group messages, participants, or test records were created in production.
- No PR was merged and no Vercel deployment was attempted.
- The linked Supabase organization is on the Free plan. The existing Rub Minds project has no development branches. Supabase quoted a development branch at **$0.01344/hour**, so no branch was created.
- Two other projects in the organization are inactive. They were not restored or repurposed as staging because their purpose/data and restoration impact have not been verified.

## Production backend inventory

- Project status: `ACTIVE_HEALTHY`; PostgreSQL engine 17 (reported version `17.11.0.003`).
- Applied migration history currently ends at `20261024002207_public_invite_rate_limits`.
- The draft Backroom migration `20261029090000_backroom_wake_queue` is **not applied**.
- `rub-minds-mcp` is active at Edge Function version 3. The existing active function inventory includes `agent-messages`, `redeem-ai-invite`, `ai-invite-discovery`, `session-memory`, and `rub-minds-mcp`.
- `backroom-config` and `backroom-wake` are **not deployed** to this production project.

**Conclusion:** Production does not contain the Backroom coordination schema or runtime. Its new queue, host lifecycle, and remote-revocation behavior cannot be validated by calling production without first deploying the feature. Production remains untouched.

## Existing hosted MCP telemetry

A sanitized query of the last 24 hours found one request to `rub-minds-mcp` whose user-agent was `openai-mcp/1.0.0`:

- Observed: 2026-10-29 13:59:46 UTC.
- HTTP response: 200.
- The corresponding server-side trace included public request-rate-limit handling and a lookup of an MCP session record.
- In the same narrow time window, no invite-redemption RPC, agent exchange, or group-message write appeared in the logs.
- The session lookup response contained no matching row; the function response was small (335 bytes). Since request bodies and MCP response bodies were not logged, the exact JSON-RPC method and response content are unavailable.

**Interpretation:** This proves that an OpenAI MCP client request reached the hosted endpoint, not that an AI successfully joined a group. The evidence is consistent with a call using a missing/expired session handle, but the request body is unavailable, so that diagnosis is not conclusive. No verified join → read context → send message → human-visible group readback round trip was established. A real Claude round trip was not established either.

A separate sanitized aggregate query over the inspected 24-hour Edge API log window showed no logged HTTP 4xx/5xx Edge API responses. This does not replace tool-level acceptance: application-level MCP errors can still be returned inside HTTP 200 responses.

## Current security-advisor findings

The live security advisor reported:

1. **Eight `SECURITY DEFINER` functions executable by authenticated users.** The functions concern room creation, invitations, room membership, or external-agent connection/revocation. This is not by itself proof of a vulnerability, since some functions intentionally need a controlled privilege boundary, but each function must be reviewed for explicit `auth.uid()`/ownership checks and minimal `EXECUTE` grants before release:
   - `connect_external_agent`
   - `create_dual_room_invite`
   - `create_room_invite`
   - `create_room_with_owner`
   - `is_room_member`
   - `redeem_room_invite`
   - `revoke_dual_room_invite`
   - `revoke_external_agent`

2. **Four tables have RLS enabled but no policies:** `agent_request_log`, `public_request_rate_limits`, `rub_minds_mcp_join_requests`, and `rub_minds_mcp_sessions`. A service-role-only server-managed design can intentionally have no user policies; verify table grants, exposed-schema accessibility, and that clients cannot read/write them directly. Do not add broad policies merely to silence the advisor.

3. **Leaked-password protection is disabled.** This is a release hardening item to assess and enable deliberately through the project Auth configuration when ready; it was not changed during this audit.

## Acceptance status for blockers 2–6

| Gate | Evidence/status | Remaining evidence needed |
|---|---|---|
| 2. Real staging backend | **Blocked: no staging project/branch available at zero verified cost.** Production inventory and logs inspected read-only. | Use a dedicated nonproduction Supabase project only after confirming it is $0 and isolated; apply the migration there, deploy Backroom functions there, then verify enrollment, pairing, claim/ack/retry, revocation, expired/offline host, and function logs. |
| 3. Real ChatGPT + Claude round trips | **Not passed.** One OpenAI MCP request reached the current endpoint, but no group join or message round trip was observed. | Use separate disposable test invites in nonproduction. Verify explicit join, context read, human message read, AI send, exact message ID readback, leave/revocation, expired invite and stale handle. Repeat independently in ChatGPT and Claude. |
| 4. Group-to-AI coordination | **Draft code and isolated tests only.** Backroom migration/functions are absent from production. | On staging, prove a committed group message produces at most one authorized wake job, the correct paired target receives the prompt, response/ack is attributed to the right session/group, retries do not duplicate, and stop/revoke/expiry cancels work. |
| 5. Browser/device automation | **Controlled-browser tests are not device acceptance.** | Run the hosted HTTPS → loopback pairing flow in desktop Chrome and Edge, review Local Network Access/origin/Host/token/XSS defenses, verify no unintended Send, test stale/replaced composers and revoke while host is online/offline. Test actual Windows and Android support separately; do not claim native drivers that are absent. |
| 6. Release/security gate | **Not passed.** Open draft PRs remain isolated; advisor findings need review; provider and staging gates are open. | Review function grants/ownership, RLS/data isolation, secrets, invite revocation, audit logs, shutdown/recovery, migration rollback and clean-checkout suites. Merge/deploy only after these gates have direct evidence. |

## Next safe sequence

1. Keep production read-only.
2. Resolve the staging-cost constraint without restoring or repurposing unrelated projects.
3. Execute staging migration/function acceptance with test-only users and disposable invites.
4. Run one genuine ChatGPT round trip and one genuine Claude round trip and preserve sanitized test evidence.
5. Re-run security review and actual-device browser tests; only then make a release decision.

The separate GitHub Actions runner/CI blocker remains intentionally out of scope for this snapshot, per the current work order.