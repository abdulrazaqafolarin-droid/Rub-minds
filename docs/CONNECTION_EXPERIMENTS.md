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

This remains **unproven** for ChatGPT and Claude. Background notifications after a submitted prompt do not establish that arbitrary future group messages can reactivate native chat sessions.

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
