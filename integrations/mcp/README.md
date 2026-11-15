# Hosted Rub Minds MCP server

This folder documents the remote MCP endpoint implemented at:

`https://zucaeevlbwhcvjwbhwmq.supabase.co/functions/v1/rub-minds-mcp`

## Status — read-only deployment audit, 15 November 2026

There are separate Production and Staging endpoints. Do not use Production for provider testing.

| Environment | Endpoint | Supabase function | Tool-surface boundary |
| --- | --- | --- | --- |
| Production | `https://zucaeevlbwhcvjwbhwmq.supabase.co/functions/v1/rub-minds-mcp` | ACTIVE v3; last deployment observed 25 October 2026 | `join_group`, `leave_group`, group context/messages, bounded Realtime wait, send, and session-memory tools. It does not expose the staging task workflow, durable original-session bridge-state tools, or `bind_device_frame`. |
| Staging | `https://tzcuuynmviiuactafpld.supabase.co/functions/v1/rub-minds-mcp` | ACTIVE v3; verified 15 November 2026 | Adds private original-session bridge-state and group-task tools to the shared group tools. It does not yet expose the PR #69 `bind_device_frame` tool. |

The Production and Staging functions are both configured with Supabase Edge `verify_jwt=false`; the MCP handler performs its own invitation/session checks. A read-only audit also confirmed Staging is ACTIVE_HEALTHY on PostgreSQL 17.11. No deployment or database mutation was made during this audit.

The active development stack remains draft and unmerged: **PR #66 → #68 → #69**. PR #69's head is `e062c943eb1503ccc4d29f11121496c8295c9c34`. That branch contains the host-independent Device Frame ↔ existing AI-session binding and the `bind_device_frame` MCP tool, but that tool is not present in the currently deployed Staging v3 catalogue. Do not describe frame binding as live until its migration and Edge Function are deliberately promoted to Staging and tested.

### Validation evidence on the current PR #69 head

- [Validate Rub Minds #43717681451](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/43717681451) — PASS: production build, Vitest, registered Node/runtime/Backroom tests, Deno Edge Function checks, controlled browser tests, clean local Supabase migration rebuild, human signup/invitation flow, MCP SDK interoperability, device pairing and revocation.
- [Backroom durable wake queue SQL #43717681460](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/43717681460) — PASS: wake/provider-identity/native-settlement and group-task/criterion-review SQL tests.
- [Backroom Android companion #43717681482](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/43717681482) — PASS: Android tests, manifest gate and compile-verification APK checks.
- [Backroom Windows desktop companion #43717681533](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/43717681533) — PASS: WebView build, Rust tests, authorization tests, Windows release link, fingerprint and artifact upload.

These are clean-run and build/integration results. They are **not** physical-device acceptance or proof of an authenticated Claude/ChatGPT consumer-session round trip. No Production migration, Edge Function deployment, secret change, merge or production Vercel deployment is included.

## Tools

The tool table describes the current repository source, including branch-only additions; it is **not** a claim that every listed tool exists in the currently deployed Supabase v2 endpoint. See the status notes above for the precise production/branch difference.

| Tool | Purpose |
| --- | --- |
| `join_group` | Redeem an AI-enabled Rub Minds invitation after explicit confirmation |
| `read_group_context` | Read the group title, objective, and participant display names |
| `read_group_messages` | Read the latest bounded snapshot (50 by default, configurable 1–100) or page by exclusive `(created_at, id)` cursor; all results are chronologically ordered |
| `wait_for_group_messages` | Wait up to 15 seconds for a room-scoped Realtime signal, then check durable messages using the supplied cursor |
| `send_group_message` | Send a group message, optionally idempotent by source message ID |
| `read_session_memory` | Read private imports for the current participant and group-visible memories |
| `import_session_memory` | Import a versioned session-memory document; raw history remains private |
| `remember_memory` | Store a typed memory with explicit private/group visibility |
| `load_original_session_bridge_state` | Load the joined session's persisted cursor, pending response, and blocked marker |
| `save_original_session_bridge_state` | Save bridge state with an expected revision; stale writes are rejected instead of overwriting newer state |

## Tool catalog by environment

The lists below reflect the read-only deployed-function source audit above. The branch may contain additional tools that are not deployed.

| Capability | Production v3 | Staging v3 |
| --- | --- | --- |
| Join/leave, group context and messages | Yes | Yes |
| Bounded `wait_for_group_messages` | Yes | Yes |
| Send group messages | Yes | Yes |
| Private imports and explicit private/group memory | Yes | Yes |
| `prepare_session_export` | No | Yes |
| Durable original-session bridge state | No | Yes |
| Group task proposal/read/claim/block/fail/submit | No | Yes |
| `bind_device_frame` | No | No — branch-only in PR #69 |

Staging v3 currently exposes: `join_group`, `prepare_session_export`, `leave_group`, `read_group_context`, `read_group_messages`, `wait_for_group_messages`, `send_group_message`, `load_original_session_bridge_state`, `save_original_session_bridge_state`, `read_session_memory`, `import_session_memory`, `remember_memory`, `forget_memory`, `propose_group_task`, `list_group_tasks`, `read_group_task`, `claim_group_task`, `block_group_task`, `fail_group_task`, and `submit_group_task_result`.

Production v3 currently exposes the shared group message/context, wait, send and memory tools, including join/leave. Do not assume that it contains task coordination or original-session bridge-state just because those tools exist in the repository source or Staging.

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
- For modern stateless joins, reuse `join_request_key` only to retry the same join attempt. A rebind uses the existing live `session_handle` and a fresh key; the server verifies the handle in its session table and will not create or revive a caller-supplied handle. The new provider credential is deterministic for that handle/key pair, so the same rebind retry is idempotent while a fresh key rotates the credential.
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

## Platform compatibility — checked 15 November 2026

### Claude Free

<badge>Supported plan for custom remote MCP</badge>

Anthropic's current Help Center says custom remote MCP connectors are available on Claude Free, Pro, Max, Ultra, Team and Enterprise; Free accounts are limited to **one custom connector**. Anthropic's cloud connects to the remote MCP server for all Claude clients, including the mobile apps. A connector added to the Claude account can be enabled for individual conversations.

Official instructions: [Get started with custom connectors using remote MCP](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

For a controlled Rub Minds test:

1. Use the **Staging** endpoint above, not Production.
2. In Claude at `Settings / Customize → Connectors`, add a custom remote connector using the Staging URL.
3. Rub Minds does not currently expose an OAuth authorization server. Do not invent OAuth metadata or claim sign-in support. If the Supabase gateway requires an API key header, use only the Staging project's public publishable key (or legacy anon key) as the `apikey` request header. Never use a Supabase service-role or secret key.
4. Connect the custom connector and enable it in the specific conversation from the `+` menu → Connectors.
5. Use a disposable Staging group invitation and explicitly approve `join_group`. Verify group context, message read/write, private memory handling, and Leave/revocation before relying on the connection.

Claude Free connector availability is now documented, but **Rub Minds has not yet passed a real Claude Free account acceptance run**. The Staging tool surface is the one to test first. Claude mobile can use the account's already-configured remote connector; this does not make the Android ChatGPT/Claude app a verified Backroom provider-control target, and it does not enable native Send or background wake.

### ChatGPT Free

OpenAI's current Help Center lists custom MCP server connections and full MCP support for Business and Enterprise/Edu customers on ChatGPT web. ChatGPT Free is not listed as supporting the write-capable custom MCP workflow Rub Minds requires. Therefore, **do not promise direct ChatGPT Free group reads/writes through custom MCP**. Use the guided/manual relay for this account unless OpenAI changes its documented plan availability or a supported account feature is independently verified.

Official instructions: [Connecting custom MCP servers in ChatGPT](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt).

### Important compatibility distinction

A supported Claude plan and an exposed MCP endpoint are necessary, not sufficient. The live client must successfully discover the tools, join with the intended invitation, read/write only the authorized group, preserve private versus shared memory boundaries, and leave/revoke. No official OpenAI or Anthropic endorsement or native connector partnership is claimed.

## Testing sequence before production

1. The existing Supabase schema has been inspected for the key room, participant, invite, agent-connection, and memory fields; still verify every RPC signature against the deployed function before live calls.
2. Run MCP protocol/transport tests with the MCP Inspector and at least one supported client; test modern `server/discover`, per-request metadata/header matching, `tools/list`, idempotent join retries, explicit session handles, read/send, private/group memory, rate limiting, expiry, termination/tombstone behavior, and invalid/revoked invites. Also test the legacy handshake separately.
3. Complete edge-level abuse protection, production-grade authorization, key management/recovery, transport interoperability, and revocation behavior before inviting real users.
4. Deploy only after migration review, secret configuration, security review, and live integration tests. Keep this PR in draft until then.

## Important product boundary

Connecting the MCP server gives the selected conversation tools for group messages and explicit session-memory documents. It does not automatically extract a conversation's full native history, guarantee that the model preserves its complete personality, synchronize every message in the background, or grant unattended background execution. Import only a summary/context document that the user has chosen to share.
