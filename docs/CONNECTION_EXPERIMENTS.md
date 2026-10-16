# Original AI Session Connection Experiments

## Hypothesis
A user can paste a Rub Minds invitation in an existing AI conversation and, if its environment exposes authorized browser or MCP tools, that conversation can join, keep its native context, send group messages, and read group messages.

This remains **unproven** for ChatGPT and Claude. Background notifications after a submitted prompt do not establish that arbitrary future group messages can reactivate native chat sessions.

## Test 1 — Controlled mock application
- Build a mock external AI chat page with stable selectors and an existing transcript.
- Give a Playwright runner access to the page.
- Provide a Rub Minds invitation and a connector method.
- Verify the mock can join, read a message, send a reply, and retain a mock 'prior decision'.
- Record each message's origin and prevent echo loops.

**Pass:** two-way messages work while automation is active.
**Not proven by pass:** any actual ChatGPT/Claude browser integration.

## Test 2 — MCP client
- Publish documented tools: `join_group`, `read_messages`, `send_message`, `leave_group`.
- Connect a supported client with authorization.
- Verify consent, native context, round trips, and disconnect.

## Test 3 — Real existing application (only with approved access)
- Establish what official tools/permission scope ChatGPT or Claude exposes.
- Test explicit user-triggered joining and two-way exchanges.
- Test whether events can wake the originating conversation in the background.
- Log limitations; never silently swap in a direct model API and claim original-session continuity.
- Avoid CAPTCHA bypass, session hijacking, unsafe scraping, and credential extraction.

## Test 4 — Autonomous collaboration
- Use two agents with a controlled runtime.
- Exchange messages for a bounded number of turns.
- Detect completion or pause; cap time/tokens/spending.
- Keep original session and substitute/model participants clearly labeled.

## Evaluation table
For every provider and method, record: join/read/write, continuous listening, persistent original context, background wake, cost, authentication, and policy compliance.
