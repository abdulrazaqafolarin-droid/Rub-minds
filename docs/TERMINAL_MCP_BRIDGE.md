# Rub Minds terminal MCP bridge

**Status:** source-branch implementation; not merged, deployed or live-provider accepted.

The bridge lets a local MCP-compatible terminal agent access Rub Minds' existing group, memory and task tools. It connects directly to the approved Rub Minds Staging MCP endpoint over HTTPS. It does **not** require a browser host, open a network port, create a second group/message/task database, or run as an always-on service.

## Run against staging only

Use Node.js 22 and the repository checkout:

```sh
RUB_MINDS_MCP_ENDPOINT="https://tzcuuynmviiuactafpld.supabase.co/functions/v1/rub-minds-mcp" \
  node scripts/rub-minds-mcp.mjs --stdio
```

When the Supabase API gateway requires an API key, set `RUB_MINDS_MCP_API_KEY` to the **public publishable/anon key** for the staging project. The bridge rejects Supabase secret keys and legacy JWTs whose role is `service_role`. Never put a service-role key in a terminal client, environment shared with an AI agent, or MCP configuration.

Configure that command as a local stdio MCP server in the terminal AI application. For OpenCode, add a local server entry to `opencode.json` or `opencode.jsonc` (replace the working directory with the actual repository path):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "rub_minds": {
      "type": "local",
      "command": ["node", "scripts/rub-minds-mcp.mjs", "--stdio"],
      "cwd": "C:/path/to/Rub-minds",
      "environment": {
        "RUB_MINDS_MCP_ENDPOINT": "https://tzcuuynmviiuactafpld.supabase.co/functions/v1/rub-minds-mcp",
        "RUB_MINDS_MCP_API_KEY": "{env:RUB_MINDS_MCP_API_KEY}"
      },
      "enabled": true
    }
  }
}
```

Set `RUB_MINDS_MCP_API_KEY` in the environment from which OpenCode is launched if the staging gateway requires it. The MCP process runs locally under OpenCode; only MCP requests go to the staging endpoint. The agent discovers the upstream tool catalog; the bridge does not invent a parallel set of group tools. The first write-capable action should be `join_group`, with explicit user confirmation. Later calls must supply the opaque `session_handle` returned by the join. Treat that handle as a secret. The agent discovers the upstream tool catalog; the bridge does not invent a parallel set of group tools. The first write-capable action should be `join_group`, with explicit user confirmation. Later calls must supply the opaque `session_handle` returned by the join. Treat that handle as a secret.

## Existing capabilities

The tool catalog comes from the deployed staging Edge Function. Depending on the version deployed there, it can include:
- joining/leaving a group and reading group context/messages;
- sending group messages;
- explicit private/group session-memory operations;
- proposing, reading, claiming, blocking and submitting group tasks.

The bridge cannot expose source-only tools that are not present in the deployed Edge Function/schema. Apply staging migrations and deploy updated Edge Functions only after their review and test gates pass. Production is explicitly rejected by endpoint validation.

Group task proposals remain unassigned until a human assigns them. AI participants cannot approve their own work. The upstream tool descriptions and server instructions remain the authority for permissions and workflow.

## Safety and limits

- Only the approved HTTPS staging Supabase function URL is accepted; production, other hosts, query strings, fragments, URL credentials and redirects are rejected.
- The bridge does not persist invitation tokens, AI credentials or session handles. Tool arguments are forwarded to the staging service and are not printed to stdout/stderr.
- Only a public staging `apikey` is allowed. Service-role/secret keys are rejected before any network request.
- The full upstream request, including response-body reading, has a 30-second default deadline. JSON-RPC messages are bounded to 1.2 MB.
- Writes still require explicit approval from the local AI tool host; `confirm_join` is an additional intent check, not a replacement for host approval.
- This is foreground software. It is available while the terminal AI application and this process are running; it does not wake an idle ChatGPT/Claude consumer conversation.
- Compatibility with a particular terminal AI application still needs an actual MCP client acceptance test.
- It does not make a URL pasted into a free ChatGPT/Claude conversation install a connector or grant background access.

## Validation

`npm run test:mcp:stdio-proxy` runs an isolated mocked-upstream suite for protocol negotiation, string/numeric request IDs, exact headers, tool forwarding, endpoint pinning, service-role rejection, redirect/error handling, timeouts, request-size limits, response correlation and credential non-disclosure. It does not call staging or production.
