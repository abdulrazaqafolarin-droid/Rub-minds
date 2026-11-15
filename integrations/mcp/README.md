# Hosted Rub Minds MCP server

This folder documents the remote MCP endpoint implemented at:

`https://zucaeevlbwhcvjwbhwmq.supabase.co/functions/v1/rub-minds-mcp`

## Status — Staging promotion and readback, 15 November 2026

There are separate Production and Staging endpoints. Do not use Production for provider testing.

| Environment | Endpoint | Supabase function | Tool-surface boundary |
| --- | --- | --- | --- |
| Production | `https://zucaeevlbwhcvjwbhwmq.supabase.co/functions/v1/rub-minds-mcp` | ACTIVE v3; last deployment observed 25 October 2026 | Shared group context/messages, bounded wait, send and session-memory tools. It does not expose the Staging task workflow, durable original-session bridge-state tools or `bind_device_frame`. |
| Staging | `https://tzcuuynmviiuactafpld.supabase.co/functions/v1/rub-minds-mcp` | ACTIVE v4; read back 15 November 2026 | Shared group/message/memory tools, Group Coordination task tools, original-session bridge-state tools and `bind_device_frame`. |

The Staging project has 46 reconciled migration-history rows. Staging `rub-minds-mcp` v4, `backroom-device` v14 and `backroom-wake` v8 are ACTIVE. The MCP handler keeps its existing invitation/session authorization model; Supabase Edge `verify_jwt=false` is not itself authentication. A readback confirmed the deployed `protocol.mjs` is byte-for-byte identical to the PR #69 branch's `integrations/mcp/protocol.mjs`, including the current tool definitions. The three relevant Edge Function versions and the migration history are Staging-only; Production was not changed.

The active development stack remains draft and unmerged: **PR #52 → #53 → #54 → #55 → #56 → #58 → #59 → #61 → #60 → #62 → #63 → #64 → #65 → #66 → #68 → #69**. PR #69 remains open and draft on branch `feat/device-frame-ai-runtime-contract`; its source implementation head `a951e4cabf71f19965694918491c5d3dadb39554` passed all four workflows. The documentation-reconciled branch head is `7bf941c8a99a3e0860aa54d639eda1632a5ce103`, and its four workflows also passed. Neither result is real-provider or physical-device acceptance.

### Validation evidence — 15 November 2026

On PR #69 source implementation head `a951e4cabf71f19965694918491c5d3dadb39554`, all four workflows passed:

- [Validate Rub Minds #43734381643](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/43734381643) — PASS: production web build, Node/Vitest/runtime/Backroom suites, Deno function checks, controlled browser tests, clean local Supabase migration rebuild, human invitation and official MCP SDK E2E, Device Frame exact-session binding.
- [Backroom durable wake queue SQL #43734381665](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/43734381665) — PASS: durable queue, provider identity, Android forwarder/settlement/attestation, Group Coordination lifecycle/dependencies and evidence-backed review.
- [Backroom Android companion #43734381654](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/43734381654) — PASS: Android protocol/unit tests and compile-verification APK build.
- [Backroom Windows desktop companion #43734381649](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/43734381649) — PASS: full web tests/build, bundled WebView, native Windows Rust tests, x64 MSVC release executable link, fingerprint and artifact upload.

The documentation-reconciled branch head `7bf941c8a99a3e0860aa54d639eda1632a5ce103` also passed all four workflows: [Android #43743998830](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/43743998830), [Windows #43743998840](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/43743998840), [Validate Rub Minds #43743998927](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/43743998927), and [durable wake SQL #43743998853](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/43743998853).

Staging SQL acceptance additionally passed for `supabase/tests/device_frame_bindings.sql`, `supabase/tests/backroom_wake_queue.sql` and `supabase/tests/group_task_coordination.sql`, each within a rollback transaction. Post-test audits found no retained fixtures; migration history remained at 46.

These checks validate source, isolated CI, Staging schema and deployed Edge Function bundles. They do **not** prove a real Claude/ChatGPT consumer-session round trip, physical Android/Windows acceptance, provider-stable conversation identity or autonomous native Send. No Production migration, Edge Function deployment, secret change, merge or production Vercel deployment is included.

## Tool catalog by environment

The Staging list below was verified by reading back the deployed v4 bundle. Its deployed `protocol.mjs` is byte-for-byte equal to the current branch source. The tool names and descriptions are therefore grounded in the deployed bundle, not inferred from the repository alone.

| Capability | Production v3 | Staging v4 |
| --- | --- | --- |
| Join/leave and read group context | Yes | Yes |
| Bounded group-message read/wait and send | Yes | Yes |
| Read one exact message by event ID | Not confirmed | Yes: `read_group_message` |
| Private session import and private/group memory | Yes | Yes |
| Explicit session export consent helper | Not confirmed | Yes: `prepare_session_export` |
| Durable original-session cursor/reply state | No | Yes |
| Group task proposal/list/read/claim/block/fail/submit | No | Yes |
| Attach existing AI session to an owner-selected frame | No | Yes: `bind_device_frame` |

Staging v4 exposes these tools:

- **Identity/session:** `join_group`, `prepare_session_export`, `leave_group`, `bind_device_frame`.
- **Group collaboration:** `read_group_context`, `read_group_messages`, `read_group_message`, `wait_for_group_messages`, `send_group_message`.
- **Original-session continuity:** `load_original_session_bridge_state`, `save_original_session_bridge_state`.
- **Session memory:** `read_session_memory`, `import_session_memory`, `remember_memory`, `forget_memory`.
- **Group Coordination:** `propose_group_task`, `list_group_tasks`, `read_group_task`, `claim_group_task`, `block_group_task`, `fail_group_task`, `submit_group_task_result`.

There is deliberately no AI-facing `review_group_task` tool: acceptance review is a human decision through the group application and the evidence-bearing authenticated review RPC. Assignment is also a human/group-coordination action; an AI can claim only a task assigned to that exact participant and only after its dependencies are complete.

Production v3 remains on the older shared group message/context, wait, send and memory surface. Do not infer task coordination, durable original-session bridge state or Device Frame binding in Production from the Staging catalogue or repository source.

## How continuous group participation fits together

The MCP catalogue is one part of the whole product loop:

1. **Group Coordination** owns the shared room state, task graph, assignments, submissions and human evidence-backed reviews.
2. A qualifying message mention or human task assignment is evaluated by the database participation policy and the durable `@RMconnects` queue.
3. The queue's canonical prompt carries an event ID, not arbitrary message text or a shell instruction. The joined AI retrieves the actual message or task using its scoped MCP session (`read_group_message`, `read_group_messages` or the task tools).
4. The original AI session replies or submits its result through the same MCP participant identity. Durable bridge state stores the cursor, pending reply and fail-closed recovery status.
5. Backroom and the draggable overlay identify a real supported app/runtime and the exact interaction target. Drag-select alone does not authorize typing, wake or Send.

A bounded `wait_for_group_messages` call is not an always-on listener. A Playwright original-session runner can repeat bounded reads while it is explicitly running in its foreground local process. An idle provider conversation needs a separately supported and authorized wake path; the MCP endpoint and Device Frame binding cannot force an idle model to start a turn. Native Send is still gated by provider-conversation identity, device attestation, consent, replay-safe settlement and physical acceptance.

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

**Supported plan for custom remote MCP**

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
