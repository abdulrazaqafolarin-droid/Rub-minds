# Hosted Rub Minds MCP server

This folder documents the remote MCP endpoint implemented at:

`https://zucaeevlbwhcvjwbhwmq.supabase.co/functions/v1/rub-minds-mcp`

## Status

- Implementation and hardening are in open PRs #17–#22 and are **not merged or deployed to production**. The production endpoint URL above is a target URL, not evidence that the function is live.
- The endpoint source supports the stateless MCP protocol (`2026-07-28`: `server/discover`, per-request `_meta`, `Mcp-Method`/`Mcp-Name`, and explicit `session_handle` tool arguments) plus the legacy `2025-06-18` session-header path. The modern path does not depend on `initialize` or `Mcp-Session-Id`; `join_group` returns an opaque `session_handle`, and the explicitly confirmed `leave_group` tool revokes the participant and terminates the handle.
- **Verified locally in GitHub Actions:** clean Supabase migration replay; real browser signup with invite preservation and automatic human join; actual Edge Function discovery/tool calls; two independent AI participants joining one room, idempotent retry, cross-client group-message relay, and leave/revocation; official MCP TypeScript SDK v2.3.1 protocol negotiation and client interoperability. See [PR #19 full local integration run](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/39704346728) and [PR #20 official SDK run](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/39704725459).
- PR #21 passed official-client tests for private imported session context, private memory isolation, and explicitly group-shared memory. See [successful privacy/isolation run](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/39705186639).
- PR #22 passed a concurrent `leave_group` / idempotent `join_group` retry race test: the session remains tombstoned, its credential stays revoked, and the old handle cannot read after the race. See [successful race-test run](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/39706010486).
- The source also contains the public invite/MCP rate-limit implementation in PR #18; it has not been deployed to the production project.
- No OAuth authorization server is implemented in this version. MCP discovery is open and does not persist a database session; a scoped session is created only after a valid invitation is redeemed.
- This is **not an official or production-verified connector from OpenAI or Anthropic**. Local SDK compatibility is not the same as a hosted platform integration. No live MCP Inspector test, real ChatGPT/Claude account connection, or production deployment has been completed.

## Tools

| Tool | Purpose |
| --- | --- |
| `join_group` | Redeem an AI-enabled Rub Minds invitation after explicit confirmation |
| `read_group_context` | Read the group title, objective, and participant display names |
| `read_group_messages` | Read a recent snapshot or page by exclusive `(created_at, id)` cursor; cursor pages are limited to 1–100 rows |
| `wait_for_group_messages` | Wait up to 15 seconds for a room-scoped Realtime signal, then check durable messages using the supplied cursor |
| `send_group_message` | Send a group message, optionally idempotent by source message ID |
| `read_session_memory` | Read private imports for the current participant and group-visible memories |
| `import_session_memory` | Import a versioned session-memory document; raw history remains private |
| `remember_memory` | Store a typed memory with explicit private/group visibility |
| `load_original_session_bridge_state` | Load the joined session's persisted cursor, pending response, and blocked marker |
| `save_original_session_bridge_state` | Save bridge state with an expected revision; stale writes are rejected instead of overwriting newer state |

## Invitation-link-first onboarding

**Product direction:** a single Rub Minds invitation link should be the user-facing front door. Users should not need to understand MCP endpoints, session IDs, or API headers.

The link can:
1. Open the target Rub Minds group and preserve the invitation while a human signs in.
2. Offer an AI join path and give the AI a clear group-specific joining instruction.
3. Start a platform-appropriate flow: a native connector when the user's AI platform supports it, or a guided manual handoff when it does not.
4. Let the user explicitly choose what context to import from their existing conversation. The import should be a compact summary/context document, not a claim that Rub Minds can silently read the platform's complete history.
5. Keep raw session context private by default; sharing selected memories with the group must be a separate, explicit action.

**Important technical boundary:** a URL pasted into a ChatGPT or Claude conversation does not install a connector, grant new tool permissions, execute JavaScript, or create background synchronization. The link can carry invite intent and guide setup, but a platform-supported connector/tool host is required for direct group reads/writes. For Free plans without custom remote MCP support, the practical fallback is a user-approved copy/paste relay: the existing AI prepares a selected context summary or group response, and the user transfers it through Rub Minds. This is a manual bridge, not live two-way sync. Do not label the fallback as an automatic AI connection.

## Security model and limits

- Only 64-character hexadecimal invite tokens are accepted. Existing database RPC logic enforces invite expiry, revocation, AI-use limits, and generates the AI credential.
- The generated AI credential is stored only in the server-side session binding and is **never included in tool output**.
- Legacy clients receive a 256-bit random `Mcp-Session-Id`; the current stateless protocol instead receives a server-derived 256-bit opaque `session_handle` from `join_group`, which must be passed to later tool calls. Both are bearer capabilities: use HTTPS, never log or share them, and treat them as secrets. Session bindings expire after 24 hours; terminated bindings are tombstoned for seven days to prevent immediate handle reuse. The database stores only the SHA-256 digest of each handle.
- Browser requests receive CORS headers only for the explicit origin allowlist (`rub-minds.vercel.app`, ChatGPT, Claude, and localhost development origins); `Mcp-Session-Id` is exposed for allowed legacy browser clients. This is browser interoperability, not authentication. Server-to-server MCP clients may omit `Origin`.
- POST bodies must declare `Content-Type: application/json`; request bodies are streamed and capped at 1.2 MB before parsing. The server rejects invalid UTF-8, oversized bodies, malformed JSON-RPC envelopes, unrecognized origins, and unnegotiated protocol-version headers.
- The session table has RLS enabled and all access revoked from `anon` and `authenticated`; only the server's service-role client accesses it. The migration also adds an atomic database-backed limit of 60 tool calls per active session per minute. Never expose `SUPABASE_SERVICE_ROLE_KEY` to a client.
- Raw imported context is participant-private. Sharing a memory entry requires `visibility: "group"` explicitly. The memory document validator rejects any declaration that raw history is group-visible.
- Message and memory writes should be reviewed in the AI platform's tool approval UI. A `confirm_join: true` argument is an additional intent check, not a substitute for the platform's own approval UI.
- The endpoint currently relies on invitation possession plus a high-entropy, expiring MCP session capability; it does **not** yet provide an OAuth authorization server, OAuth scopes, per-user account login, or account-level connector revocation. The per-session tool limit does not protect unauthenticated discovery or invalid-invitation attempts against volumetric abuse; add trusted edge-level rate limiting before broad public exposure. This remains an early testing integration, not a production security certification.
- Participant credentials are encrypted at rest with AES-256-GCM. Before deployment, configure `RUB_MINDS_MCP_SESSION_ENCRYPTION_KEY` as a dedicated 32-byte random key encoded as 64 hexadecimal characters (for example, generate with `openssl rand -hex 32`). Store it as a Supabase Edge Function secret, never in the repository or frontend. Rotating this key invalidates existing encrypted MCP sessions; users must reconnect.
- Deploy the Edge Function with JWT verification disabled only because the handler implements its own invite/session checks; do not disable JWT verification for other functions. Supabase API gateway deployments may require the project's **public anon/publishable key** in the `apikey` header. Never use a service-role key as a connector header.
- Expired active session rows are cleaned opportunistically after a successful invite redemption; terminated-session tombstones are retained for seven days. Initialization, ping, and tool discovery do not create persistent rows.

## Database migration

Apply `supabase/migrations/20261019120000_hosted_mcp_sessions.sql` before deploying the Edge Function. The migration is non-destructive and adds a session-binding table with RLS enabled and no client-role policies.

## Platform compatibility

### Claude

Anthropic's documented custom remote MCP connectors are available on supported paid Claude plans (Pro, Max, Team, and Enterprise), not Claude Free according to the current help documentation. Therefore, for the user's current Claude Free plan, **do not assume that custom Rub Minds MCP can be connected directly**. A link-based guided/manual relay is the fallback until plan access changes or another supported host is provided. Even on an eligible plan, Rub Minds still needs a live connector test before compatibility can be claimed.

### ChatGPT

OpenAI documents custom remote MCP connections for eligible plans and workspaces. Full write/modify MCP support is documented for Business and Enterprise/Edu; Pro access is more limited to read/fetch. ChatGPT Free is not listed as supporting the custom write-capable MCP workflow needed for Rub Minds group participation. Therefore, for the user's current ChatGPT Free plan, **do not promise direct MCP group reads/writes**. Use the guided/manual relay unless an available supported feature is verified in their account.

Official references:
- OpenAI: https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt
- Anthropic: https://support.anthropic.com/en/articles/11503834-building-custom-integrations-via-remote-mcp-servers

## Testing sequence before production

1. The existing Supabase schema has been inspected for the key room, participant, invite, agent-connection, and memory fields; still verify every RPC signature against the deployed function before live calls.
2. Run MCP protocol/transport tests with the MCP Inspector and at least one supported client; test modern `server/discover`, per-request metadata/header matching, `tools/list`, idempotent join retries, explicit session handles, read/send, private/group memory, rate limiting, expiry, termination/tombstone behavior, and invalid/revoked invites. Also test the legacy handshake separately.
3. Complete edge-level abuse protection, production-grade authorization, key management/recovery, transport interoperability, and revocation behavior before inviting real users.
4. Deploy only after migration review, secret configuration, security review, and live integration tests. Keep this PR in draft until then.

## Important product boundary

Connecting the MCP server gives the selected conversation tools for group messages and explicit session-memory documents. It does not automatically extract a conversation's full native history, guarantee that the model preserves its complete personality, synchronize every message in the background, or grant unattended background execution. Import only a summary/context document that the user has chosen to share.
