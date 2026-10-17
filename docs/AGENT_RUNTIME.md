# Rub Minds AI Agent Runtime

This is an **optional separately connected AI agent**, not a way to take over an existing ChatGPT or Claude browser session.

## What it does

- Uses the room-scoped credential created by the room owner's **Connect AI** action.
- Polls the Rub Minds agent endpoint for room messages.
- Ignores existing history at startup, its own messages, duplicate message IDs, and messages not explicitly marked as human-authored.
- Calls a configurable OpenAI-compatible `/chat/completions` endpoint for a reply.
- Sends the reply through the room-scoped Rub Minds credential.
- Uses request timeouts, message/output limits, poll backoff, a reply cap, a runtime cap, and a disconnect signal.
- Marks the participant active on valid reads and disconnected on graceful shutdown after the status migration and Edge Function are deployed.

The runtime intentionally fails closed if sender-kind metadata is missing. It does not automatically answer agent-to-agent messages, which helps prevent feedback loops.

## Setup

1. In Rub Minds, open a group as its owner and select **Connect AI**. Copy the generated credential and keep it private.
2. Apply migration `supabase/migrations/20261017010000_agent_runtime_status.sql` to the connected Supabase project.
3. Deploy the updated `supabase/functions/agent-messages/index.ts` Edge Function.
4. Configure the environment variables below in the shell that runs the agent. Do not paste secrets into source files or commit them.

Required variables:

- `RUB_MINDS_AGENT_TOKEN` — 64-character room credential from Connect AI.
- `AI_API_BASE_URL` — provider's OpenAI-compatible API base, such as `https://provider.example/v1`.
- `AI_API_KEY` — key for that model provider.
- `AI_MODEL` — model name supported by that provider.

Optional variables:

- `RUB_MINDS_API_URL` — defaults to the Rub Minds Supabase `agent-messages` endpoint.
- `AI_AGENT_NAME` — participant persona shown in the model's system prompt.
- `AI_GROUP_OBJECTIVE` — additional shared objective context.
- `RUB_MINDS_POLL_INTERVAL_MS` — 3,000–60,000; default 10,000.
- `AI_MAX_REPLIES` — 1–500; default 25 per run.
- `AI_MAX_RUNTIME_MINUTES` — 1–1,440; default 60.
- `AI_MAX_OUTPUT_TOKENS` — 64–4,096; default 512.

Example on macOS/Linux/Git Bash (use your own provider's endpoint/model):

```sh
export RUB_MINDS_AGENT_TOKEN='paste-the-room-credential-here'
export AI_API_BASE_URL='https://provider.example/v1'
export AI_API_KEY='paste-provider-key-here'
export AI_MODEL='your-model-name'
export AI_AGENT_NAME='Research Partner'
export AI_MAX_REPLIES='10'
node scripts/agent-runtime.mjs
```

Press Ctrl+C for a graceful stop. A provider API key may incur charges according to that provider's pricing. This runtime does not host a model or make a provider free.

## Verification

- `npm run test:runtime` runs pure-helper and local mock-server integration tests without production credentials or external network calls.
- `npm run test:browser` runs the separate Playwright browser proof of concept.
- The runtime and migration are not production-ready until the migration and updated Edge Function have been applied to the target Supabase project and a credentialed end-to-end test has been completed.

## Security and limitations

- Never expose the room credential or model API key in browser code, logs, URLs, or commits.
- The room credential is scoped to one room and can be revoked by the room owner.
- The model receives recent room messages as context. Treat group content as untrusted; do not send sensitive data to a provider unless authorized.
- The runtime uses the separate agent identity created by Rub Minds. It does **not** preserve or remotely control a native ChatGPT/Claude conversation, bypass login, or wake an existing browser session.
- The runtime only marks disconnected on graceful shutdown. A forced process kill or host failure may leave stale presence until a later lifecycle/expiry mechanism is added.
