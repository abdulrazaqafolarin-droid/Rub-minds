# Rub Minds terminal MCP bridge

**Status:** source-branch implementation; not merged, deployed or live-provider accepted.

The terminal bridge lets a local MCP-compatible AI agent use the existing Rub Minds group, memory and task tools. It connects directly to the hosted MCP endpoint over HTTPS. It does **not** require the Backroom browser host, open a network port, create a second message/task database, or run as an always-on service.

## Run

Use Node.js 22 (the repository's current CI runtime) and the repository checkout:

```sh
RUB_MINDS_MCP_ENDPOINT="https://YOUR-PROJECT.supabase.co/functions/v1/rub-minds-mcp" \
  node scripts/rub-minds-mcp.mjs --stdio
```

When the Supabase API gateway requires an API key, also set `RUB_MINDS_MCP_API_KEY` to the project's **public publishable/anon key**. Never put a service-role key in a terminal client, environment shared with an AI agent, or MCP configuration.

Configure that command as a local stdio MCP server in the terminal AI application. The agent discovers the existing tools from Rub Minds; no new tool names or group storage are introduced. The first tool it should request is `join_group`, with explicit user confirmation. Later calls must supply the opaque `session_handle` returned by that tool. Treat this handle as a secret.

## What it exposes

The proxy forwards the hosted server's current source-defined tools unchanged, including:
- joining and leaving a group;
- reading group context and messages, and sending group messages;
- explicit private/group session memory operations;
- proposing, reading, claiming, blocking and submitting group tasks.

Group task proposals remain unassigned until a human assigns them. AI participants cannot approve their own work. The tool descriptions and server instructions remain the authority for permissions and workflow.

## Safety and limits

- Endpoint must be an HTTPS Supabase `/functions/v1/rub-minds-mcp` URL; query strings, fragments, credentials and redirects are rejected.
- The bridge does not persist invite tokens, AI credentials or session handles. Tool arguments pass through the caller's local MCP transport and are not printed to stdout/stderr.
- The optional `apikey` header accepts only a public project key. Never use `SUPABASE_SERVICE_ROLE_KEY`.
- Writes still require explicit approval from the local AI tool host; `confirm_join` is an additional intent check, not a replacement for the tool host's approval.
- A local stdio bridge is foreground software: it is available while the terminal agent and this process are running. It does not wake an idle external ChatGPT/Claude consumer conversation.
- This does not prove compatibility with a particular terminal agent. Verify the local MCP host's stdio support and run the staging acceptance checklist before production use.
- It does not make a URL pasted into a free ChatGPT/Claude conversation install the connector or grant background access.

## Validation

The unit suite uses a mocked upstream server to check protocol negotiation, exact headers, discovery, forwarding, URL validation, redirect rejection, request-size limits, response correlation and credential non-disclosure. It does not call staging or production.
