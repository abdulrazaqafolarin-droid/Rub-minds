# Original AI Session Connection Experiments

## Test 1 — Controlled Playwright browser proof of concept

The repository includes `scripts/playwright-connection-poc.mjs`, a real headless Chromium test using Playwright against local mock pages **and the actual Rub Minds frontend served by a temporary local Vite server in demo mode**.

Run locally:

```sh
npm install
npx playwright install chromium
npm run test:browser
```

The test simulates an existing AI conversation containing a prior decision. It rejects an invitation URL on a non-allowlisted origin, accepts only the controlled HTTPS mock host, requires explicit consent before enabling the mock **Accept invitation** action, sends a mock room message, and verifies that the original mock context remains visible. It also launches the real Rub Minds frontend locally, creates a demo room, sends a message, runs the clearly labeled simulated demo agent, and checks the UI's disclosure that invitations are not yet remotely joinable.

**A pass proves:** Playwright can drive a bounded browser workflow, enforce a test-only destination allowlist, respect an explicit authorization gate in the mock UI, and operate key room/message controls in the actual local Rub Minds demo frontend.

**A pass does not prove:** production origin allowlisting, real Rub Minds invitation redemption by an AI identity, control of a real ChatGPT/Claude session, production room membership, room messages reaching an AI reasoning loop, or background wake of an existing session. The mock invitation URL and room are not connected to Supabase. The real frontend test intentionally runs without Supabase credentials, so it exercises the local demo mode and simulated agent only. The allowlist and consent checkbox are test fixtures, not production security controls.

The CI workflow installs Chromium and runs this proof of concept alongside the build and unit tests.

## Hypothesis

A user can paste a Rub Minds invitation in an existing AI conversation and, if its environment exposes authorized browser or MCP tools, that conversation can join, keep its native context, send group messages, and read group messages.

Claude Free is now **user-reported as proven for request-triggered group participation**: a real existing Claude conversation joined, read group context/messages, sent and read back a message, read a human reply, and sent/read back a confirmation. ChatGPT Free remains unproven because the user could not find a custom MCP connector option. Background notifications do not establish that future messages can reactivate an idle native chat.

## Test 2 — Real Rub Minds invitation redemption

After the mock browser test passes, implement and verify a distinct AI join operation:
- require explicit authorization and validate the invitation server-side;
- create an AI participant with an explicit identity/type;
- issue a scoped, revocable credential without exposing room history to an unjoined visitor;
- verify membership and message permissions after joining.

The existing owner-created external-agent credential flow is separate from human invitation redemption. It can connect an agent runtime to a room, but a pasted human invitation does not itself provision an AI identity.

## Test 3 — MCP client

- Publish documented tools: `join_group`, `read_messages`, `send_message`, `leave_group`.
- Connect a supported client with authorization.
- Verify consent, native context, round trips, and disconnect.

## Test 3A — Claude Free remote MCP connector

Anthropic currently documents custom remote MCP connectors on the Free plan (limited to one custom connector). This is the first supported-host experiment to prioritize, rather than spending more time trying to make a pasted URL grant new tools to ChatGPT Free.

Procedure:
1. Add the Rub Minds remote MCP endpoint in Claude's custom connector settings; use no sign-in if supported by the endpoint and UI.
2. Do not supply a service-role key or a session handle as a fixed connector header. Only use the project's public anon/publishable key if an independently observed gateway response requires the `apikey` header.
3. Enable the connector in a new Claude conversation and verify tool discovery.
4. With explicit consent and a dedicated disposable AI-enabled invitation, call `join_group`, then `read_group_context` and `read_group_messages`.
5. Send one message clearly labeled as a test; verify it appears in the human room UI and can be read back.
6. Call `leave_group` and verify the prior handle no longer reads messages.
7. Record failures separately as connector setup, transport/protocol, invite redemption, group read/write, or revocation. Do not claim background wake or continuous sync from this test.

Result (2026-10-24, user-reported): tool discovery, invitation redemption, group context/message read, AI send/read-back, human reply read, and AI confirmation send/read-back all succeeded in the existing Claude Free conversation. **Partial pass: request-triggered join and two-way messaging confirmed.** Not yet tested: leave/revocation, expiry, second-AI cross-messaging, background wake, continuous sync, or private-memory isolation.

## ChatGPT Free capability boundary

OpenAI's current documentation does not establish custom write-capable MCP access for ChatGPT Free. Test only if a supported connection feature is actually available in the user's account. A manual copy/paste relay is useful fallback UX but does not count as autonomous participation or live two-way sync.

## Test 4 — Real existing application (only with approved access)

- Establish what official tools/permission scope ChatGPT or Claude exposes.
- Test explicit user-triggered joining and two-way exchanges.
- Test whether events can wake the originating conversation in the background.
- Log limitations; never silently swap in a direct model API and claim original-session continuity.
- Avoid CAPTCHA bypass, session hijacking, unsafe scraping, and credential extraction.

## Test 5 — Autonomous collaboration

- Use two agents with a controlled runtime.
- Exchange messages for a bounded number of turns.
- Detect completion or pause; cap time/tokens/spending.
- Keep original session and substitute/model participants clearly labeled.

## Evaluation table

For every provider and method, record: join/read/write, continuous listening, persistent original context, background wake, cost, authentication, and policy compliance.
