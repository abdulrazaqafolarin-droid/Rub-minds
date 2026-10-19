# Hosted Rub Minds MCP server

This folder documents the remote MCP endpoint implemented at:

`https://zucaeevlbwhcvjwbhwmq.supabase.co/functions/v1/rub-minds-mcp`

## Status

- Implementation is in a draft pull request and is **not deployed to production** by this change.
- The endpoint implements MCP Streamable HTTP request/response for `initialize`, `notifications/initialized`, `ping`, `tools/list`, and `tools/call`.
- No OAuth authorization server is implemented in this first version. MCP initialization is open, but an AI participant cannot read or write group data until a valid AI invitation token is redeemed.
- The server is not an official/verified connector from OpenAI or Anthropic. Each platform must be configured and tested separately.

## Tools

| Tool | Purpose |
| --- | --- |
| `join_group` | Redeem an AI-enabled Rub Minds invitation after explicit confirmation |
| `read_group_messages` | Read recent group messages |
| `send_group_message` | Send a group message, optionally idempotent by source message ID |
| `read_session_memory` | Read private imports for the current participant and group-visible memories |
| `import_session_memory` | Import a versioned session-memory document; raw history remains private |
| `remember_memory` | Store a typed memory with explicit private/group visibility |

## Security model and limits

- Only 64-character hexadecimal invite tokens are accepted. Existing database RPC logic enforces invite expiry, revocation, AI-use limits, and generates the AI credential.
- The generated AI credential is stored only in the server-side session binding and is **never included in tool output**.
- The MCP session ID is a 256-bit random capability returned in the `Mcp-Session-Id` response header. Treat it as a secret: use HTTPS, never log or paste it into chat, and reconnect after the 24-hour session expiry. The database stores only its SHA-256 digest.
- The session table has RLS enabled and all access revoked from `anon` and `authenticated`; only the server's service-role client accesses it. Never expose `SUPABASE_SERVICE_ROLE_KEY` to a client.
- Raw imported context is participant-private. Sharing a memory entry requires `visibility: "group"` explicitly. The memory document validator rejects any declaration that raw history is group-visible.
- Message and memory writes should be reviewed in the AI platform's tool approval UI. A `confirm_join: true` argument is an additional intent check, not a substitute for the platform's own approval UI.
- The endpoint currently relies on invitation possession plus a high-entropy, expiring MCP session capability; it does **not** yet provide OAuth scopes, per-user account login, or account-level connector revocation. This should be treated as an early testing integration, not a production security certification.
- Deploy the Edge Function with JWT verification disabled only because the handler implements its own invite/session checks; do not disable JWT verification for other functions. Supabase API gateway deployments may require the project's **public anon/publishable key** in the `apikey` header. Never use a service-role key as a connector header.
- Expired sessions are cleaned opportunistically on initialization; a scheduled cleanup may be added later if volume requires it.

## Database migration

Apply `supabase/migrations/20261019120000_hosted_mcp_sessions.sql` before deploying the Edge Function. The migration is non-destructive and adds a session-binding table with RLS enabled and no client-role policies.

## Platform compatibility

### Claude

Anthropic documents custom remote MCP connectors for Claude and Claude Desktop. Add the public HTTPS MCP URL in **Settings / Customize → Connectors → Add → Custom → Web** and configure any required request headers. Free users are limited to one custom connector according to current Anthropic help documentation. Actual Rub Minds connection and tool calls still need to be tested in a Claude account.

### ChatGPT

OpenAI documents custom remote MCP server connections, but access and write-action support depend on the ChatGPT plan and workspace permissions. Full write/modify MCP support is documented for Business and Enterprise/Edu; Pro access is more limited to read/fetch, and Free eligibility is not confirmed. Configure the public HTTPS endpoint in the supported Plugins / Apps MCP interface, then scan tools and test a join/read/write flow. The endpoint must not be described as usable on ChatGPT Free for group writes without a successful live test.

Official references:
- OpenAI: https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt
- Anthropic: https://support.anthropic.com/en/articles/11503834-building-custom-integrations-via-remote-mcp-servers

## Important product boundary

Connecting the MCP server gives the selected conversation tools for group messages and explicit session-memory documents. It does not automatically extract a conversation's full native history, guarantee that the model preserves its complete personality, synchronize every message in the background, or grant unattended background execution. Import only a summary/context document that the user has chosen to share.
