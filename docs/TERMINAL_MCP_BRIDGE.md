# Rub Minds terminal MCP bridge

**Status:** source-branch implementation; not merged, deployed or live-provider accepted.

The bridge lets a local MCP-compatible terminal agent access Rub Minds' existing group, memory and task tools. It connects directly to the approved Rub Minds Staging MCP endpoint over HTTPS. It does **not** require a browser host, open a network port, create a second group/message/task database, or run as an always-on service.

## Run against Staging only

Use Node.js 22 and a repository checkout:

```powershell
$env:RUB_MINDS_MCP_ENDPOINT = "https://tzcuuynmviiuactafpld.supabase.co/functions/v1/rub-minds-mcp"
node .\scripts\rub-minds-mcp.mjs --stdio
```

When the Supabase API gateway requires an API key, set `RUB_MINDS_MCP_API_KEY` to the **public publishable/anon key** for the Staging project. The bridge rejects Supabase secret keys and legacy JWTs whose role is `service_role`. Never put a service-role key in a terminal client, environment shared with an AI agent, or MCP configuration.

The endpoint is pinned in the bridge to the dedicated Staging project. The environment variable must match that exact URL; Production, arbitrary hosts, query strings, fragments, URL credentials and redirects are rejected.

## OpenCode (current V2 configuration)

OpenCode's current V2 configuration puts named MCP servers under `mcp.servers`. The server names are not direct properties of `mcp`. Add this to the repository's `opencode.json` or `opencode.jsonc` and replace the working directory with the absolute repository path:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "rub_minds": {
        "type": "local",
        "command": ["node", "scripts/rub-minds-mcp.mjs", "--stdio"],
        "cwd": "C:/path/to/Rub-minds",
        "environment": {
          "RUB_MINDS_MCP_ENDPOINT": "https://tzcuuynmviiuactafpld.supabase.co/functions/v1/rub-minds-mcp",
          "RUB_MINDS_MCP_API_KEY": "{env:RUB_MINDS_MCP_API_KEY}"
        },
        "protocol": "legacy",
        "codemode": false
      }
    }
  }
}
```

The `RUB_MINDS_MCP_API_KEY` entry is optional when the gateway does not require an `apikey` header. When it is required, define that variable in the environment used to launch OpenCode; use only the public Staging publishable/anon key. `protocol: "legacy"` selects the local 2025-06-18 MCP handshake used by this bridge; the bridge independently negotiates the modern upstream protocol with the Staging endpoint. `codemode: false` exposes the discovered tools directly in OpenCode.

From the repository workspace, check the connection with `opencode mcp list` and inspect the server from OpenCode's MCP view. The official configuration reference is https://opencode.ai/docs/mcp-servers/.

## Claude Code CLI (local stdio)

Claude Code supports local stdio MCP servers. From the repository root, register the command in user scope (the server configuration is stored in your local Claude Code user configuration, not committed to the repository):

```powershell
$repo = (Get-Location).Path
claude mcp add --scope user --env "RUB_MINDS_MCP_ENDPOINT=https://tzcuuynmviiuactafpld.supabase.co/functions/v1/rub-minds-mcp" --transport stdio rub-minds -- node "$repo\scripts\rub-minds-mcp.mjs" --stdio
```

Set `RUB_MINDS_MCP_ENDPOINT` in the environment used to launch Claude Code. If the Staging gateway requires an API key, also set `RUB_MINDS_MCP_API_KEY` there to the public Staging publishable/anon key. Restart Claude Code after changing the process environment so the local MCP child process inherits the values.

The ordering above matches the tested CLI syntax: flags and environment options come before `--transport stdio`, then the server name and `--` separator. In CI, the actual Claude Code CLI successfully reports the spawned Rub Minds bridge as `✔ Connected` against a mock-only upstream. This verifies CLI registration/connection, not a live authenticated group session.

Verify the registration with:

```powershell
claude mcp get rub-minds
```

Then run `/mcp` inside Claude Code to inspect the connection and available tools. The official setup reference is https://code.claude.com/docs/en/mcp.

These are **terminal-client** integrations. They do not install a connector into a normal claude.ai browser conversation or a free ChatGPT web conversation, and do not grant those consumer sessions background access.

## Existing capabilities

The tool catalog comes from the deployed Staging Edge Function. Depending on the version deployed there, it can include:
- joining/leaving a group and reading group context/messages;
- sending group messages;
- explicit private/group session-memory operations;
- proposing, reading, claiming, blocking and submitting group tasks.

The bridge cannot expose source-only tools that are not present in the deployed Edge Function/schema. Apply Staging migrations and deploy updated Edge Functions only after their review and test gates pass. Production is explicitly rejected by endpoint validation.

Group task proposals remain unassigned until a human assigns them. AI participants cannot approve their own work. The upstream tool descriptions and server instructions remain the authority for permissions and workflow.

## Safety and limits

- Only the approved HTTPS Staging Supabase function URL is accepted; Production, other hosts, query strings, fragments, URL credentials and redirects are rejected.
- The bridge does not persist invitation tokens, AI credentials or session handles. Tool arguments are forwarded to the Staging service and are not printed to stdout/stderr.
- Only a public Staging `apikey` is allowed. Service-role/secret keys are rejected before any network request.
- The full upstream request, including response-body reading, has a 30-second default deadline. JSON-RPC messages are bounded to 1.2 MB.
- Writes still require explicit approval from the local AI tool host; `confirm_join` is an additional intent check, not a replacement for host approval.
- This is foreground software. It is available while the terminal AI application and this process are running; it does not wake an idle ChatGPT/Claude consumer conversation.
- Compatibility with the official MCP client protocol and the OpenCode V2 / Claude Code CLI connection setup are tested in CI. Real authenticated Staging group acceptance remains a separate Milestone C check.
- It does not make a URL pasted into a free ChatGPT/Claude conversation install a connector or grant background access.

## Validation

- `npm run test:mcp:stdio-proxy` runs an isolated mocked-upstream suite for protocol negotiation, string/numeric request IDs, exact headers, tool forwarding, endpoint pinning, service-role rejection, redirect/error handling, timeouts, request-size limits, response correlation and credential non-disclosure.
- `npm run test:mcp:stdio-proxy:interop` launches the actual `rub-minds-mcp.mjs --stdio` child process and connects to it with the pinned official MCP TypeScript client. It verifies initialization, tool discovery, explicit group joining, message retrieval and sending, task proposal/list/read, rejection of a proposed-but-unassigned task claim, claim/submission of a separate fixture task that is already assigned to the test participant, explicit group leave, and denial of message reads after session revocation. A child-process-only fetch fixture intercepts the single pinned Staging URL and rejects every other network request. It does **not** call Staging or Production.
- The GitHub Actions interoperability job installs the official MCP TypeScript client in its disposable runner and executes this test. It does not add that SDK to the runtime dependencies of Rub Minds.
- A separate GitHub Actions job installs the **official OpenCode V2 CLI**, creates an isolated project-level `opencode.json` using the documented `mcp.servers` structure, then runs `opencode mcp list` until the server reports connected or the bounded retry window expires. The local bridge child process alone receives the isolated fetch fixture; the OpenCode CLI itself is not patched. No model provider or paid API key is used.
- A separate GitHub Actions job installs the **official Claude Code CLI**, registers the bridge at user scope inside a disposable `CLAUDE_CONFIG_DIR`, and requires `claude mcp get rub_minds` to report `Connected`. Its child bridge process uses the same isolated mock upstream; no Claude sign-in, model request, Staging call or Production call is made.

The official SDK test proves stdio request/call behavior and the fixture's group/task contracts. The OpenCode V2 and Claude Code CLI jobs prove that both real terminal clients can register and connect to the spawned bridge. None of these jobs calls live Staging or Production, and they do not prove the user's local credentials or a deployed group/task flow. Those remain separate Milestone C acceptance cases after Staging is isolated and its current MCP schema and migrations are deployed.
