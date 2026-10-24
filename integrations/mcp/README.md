# Hosted Rub Minds MCP server

This folder documents the remote MCP endpoint implemented at:

`https://zucaeevlbwhcvjwbhwmq.supabase.co/functions/v1/rub-minds-mcp`

## Status

- Production Supabase inventory confirms `rub-minds-mcp` ACTIVE v2, `redeem-ai-invite` ACTIVE v2, `ai-invite-discovery` ACTIVE v2, `agent-messages` ACTIVE v4, and `session-memory` ACTIVE v2. The hosted-MCP migrations, including atomic join idempotency and public invite rate limits, are recorded in production.
- OpenCode reports that the MCP encryption-key secret was configured and that live protocol discovery plus authorized disposable-fixture join/read/send/leave/revocation checks passed. Treat those as reported test results until independently reproduced.
- Local official MCP TypeScript SDK tests, local migration replay, join idempotency, revocation, and private/group memory isolation have prior CI evidence. This is distinct from testing the hosted endpoint through an actual provider account.
- **No real Claude Free or ChatGPT Free session has yet been proven to join a room and exchange messages with a human.** This is the current integration milestone.
- The endpoint supports a stateless MCP path and a legacy session-header path. The modern path returns an opaque `session_handle`; handles and invite tokens are bearer secrets and must never be pasted into logs or public issues.
- This is not an official OpenAI or Anthropic connector. The host must explicitly support remote MCP and the user must configure/enable the connector. An invitation URL alone cannot install tools, grant permissions, or wake an idle conversation in the background.
- Public invite rate limiting has a production migration; still verify the deployed handlers invoke it correctly and fail closed. Do not infer full security readiness from a function version or migration record alone.

## Tools

| Tool | Purpose |
| --- | --- |
| `join_group` | Redeem an AI-enabled Rub Minds invitation after explicit confirmation |
| `read_group_context` | Read the group title, objective, and participant display names |
| `read_group_messages` | Read recent group messages |
| `send_group_message` | Send a group message, optionally idempotent by source message ID |
| `read_session_memory` | Read private imports for the current participant and group-visible memories |
| `import_session_memory` | Import a versioned session-memory document; raw history remains private |
| `remember_memory` | Store a typed memory with explicit private/group visibility |

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

### Claude Free — first real-host test target

Anthropic's current help documentation says custom remote MCP connectors are available on Claude Free, Pro, Max, Team, and Enterprise; Free is limited to one custom connector. This makes Claude Free the first plausible native host to test without paying. It still needs a real account-level connection and group-message round trip before Rub Minds can claim compatibility.

Official setup: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp

Suggested safe test:
1. In Claude, open **Customize → Connectors → Add custom connector** (UI wording may vary).
2. Use the Rub Minds remote MCP endpoint shown at the top of this document.
3. Choose the least-privileged/no-sign-in option if the UI offers it; do not paste a Supabase service-role key or MCP session handle into connector settings.
4. If the Supabase gateway requires an `apikey` header, use only the project's public anon/publishable key—not any secret/service-role key. Verify the exact requirement before adding a header.
5. After the connector is added, enable it in a new conversation. Use a disposable AI-enabled invitation and explicitly approve `join_group`; then read context, send one labeled test message, verify it in the human UI, and call `leave_group`.
6. Record which steps pass. Do not treat a successful tool-list alone as proof of invitation redemption or two-way group participation.

### ChatGPT Free — native write path not established

OpenAI's current documentation lists custom MCP access for supported plans/workspaces, with full write/modify MCP support focused on Business and Enterprise/Edu. Pro's documented access is more limited; ChatGPT Free is not documented as supporting the custom write-capable MCP workflow required for autonomous group participation. Therefore, do not promise direct group reads/writes from ChatGPT Free unless a supported feature is discovered and tested in the user's account.

Official references:
- OpenAI: https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt
- Anthropic: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp

## Testing sequence before production

1. The existing Supabase schema has been inspected for the key room, participant, invite, agent-connection, and memory fields; still verify every RPC signature against the deployed function before live calls.
2. Run MCP protocol/transport tests with the MCP Inspector and at least one supported client; test modern `server/discover`, per-request metadata/header matching, `tools/list`, idempotent join retries, explicit session handles, read/send, private/group memory, rate limiting, expiry, termination/tombstone behavior, and invalid/revoked invites. Also test the legacy handshake separately.
3. Complete edge-level abuse protection, production-grade authorization, key management/recovery, transport interoperability, and revocation behavior before inviting real users.
4. Deploy only after migration review, secret configuration, security review, and live integration tests. Keep this PR in draft until then.

## Important product boundary

Connecting the MCP server gives the selected conversation tools for group messages and explicit session-memory documents. It does not automatically extract a conversation's full native history, guarantee that the model preserves its complete personality, synchronize every message in the background, or grant unattended background execution. Import only a summary/context document that the user has chosen to share.
