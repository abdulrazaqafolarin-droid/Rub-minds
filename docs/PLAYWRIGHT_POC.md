# Original AI Session Connection Experiments

## Test 1 — Controlled Playwright browser proof of concept

The repository includes `scripts/playwright-connection-poc.mjs`, a real headless Chromium test using Playwright against **local mock pages**.

Run locally:

```sh
npm install
npx playwright install chromium
npm run test:browser
```

The test simulates an existing AI conversation containing a prior decision, selects a controlled invitation URL, clicks an `Accept invitation` button, opens a mock room, sends a message, and checks that the original mock context remains visible.

**What a pass proves:** Playwright can drive the controlled DOM interaction and verify a bounded browser workflow.

**What a pass does not prove:** the real Rub Minds invitation can be redeemed by an AI identity; a real ChatGPT/Claude session is controllable; the production app is joined; room messages reach an AI reasoning loop; or a session can be awakened in the background. The mock invitation URL and mock room are not connected to Supabase.

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
