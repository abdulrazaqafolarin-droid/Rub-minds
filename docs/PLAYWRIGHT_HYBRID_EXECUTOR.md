# Playwright hybrid executor (Model C)

## Goal
Use a connected original AI conversation when explicitly available. If it is unavailable, optionally use a separately authenticated browser AI session that receives only an approved context brief. Playwright automates authorized UI interactions; it does not create AI capabilities by itself.

## Components
- `session-bridge.mjs`: bounded group-message-to-AI loop; only human-origin messages are passed to the AI, preventing obvious agent echo loops.
- `hybrid-session-coordinator.mjs`: selects original session first, then independent session only when fallback was explicitly allowed.
- Provider adapter (next): Playwright locators for a supported AI UI, verified by live tests. It must detect login, composer, response completion, and errors rather than relying on guessed selectors.
- Rub Minds transport: use existing authenticated `agent-messages` API.
- Persistent process: run on a machine/host with Playwright installed and an authorized browser. Playwright is not a hosted service; process shutdown stops the loop.

## Original session mode
Use only a browser session the user deliberately connected. The safest supported approach is an explicit Playwright connection to a browser launched with a user-controlled debugging endpoint, or a dedicated profile the user has logged into themselves. Never extract cookies from a browser profile, bypass MFA/CAPTCHA, or reuse a session without the owner's informed permission. The original conversation remains authoritative for its context; only group messages and responses that the user approved are relayed.

## Independent fallback mode
Create a new isolated browser context/profile. The user logs in directly to the AI provider in that context. Do not copy cookies, storage, credentials, or hidden conversation history from the original profile. Initialize with a user-approved context brief. Label the participant as an independent AI session in the Rub Minds UI.

## Required protections
- Explicit opt-in for join, message relay, and fallback.
- Start/stop controls and visible active-mode indicator.
- Human-only input filter by default; explicit policy needed for AI-to-AI handoffs.
- Message ID dedupe, bounded retries, reply cap, per-agent rate limits, max turn depth, and loop breaker.
- Treat room messages as untrusted data; do not let them override system/developer instructions.
- Never log invitation tokens, agent bearer credentials, browser cookies, or raw authorization headers.
- Handle disconnected sessions, login expiry, rate limits, provider errors, and ambiguous send completion without blindly retrying.
- Respect provider terms and platform UI automation policies.

## Limits
The coordinator is a scaffold and the message bridge is a scaffold. Neither is yet tested against a real provider UI or production room. A long-running Playwright process needs an available host. This approach can continue the separate session, but cannot guarantee that the original ChatGPT conversation itself stays active when the user closes it or its host disables tools.

## Acceptance tests
1. Original session ready -> selected; fallback is not started.
2. Original unavailable + fallback disabled -> remains waiting.
3. Original unavailable + fallback explicitly enabled -> isolated independent session created.
4. Never copy original session cookies/storage.
5. User approval required to start and step.
6. Duplicate group messages and agent-origin messages do not cause repeated/recursive replies.
7. Reply cap and stop close the loop.
8. Login expiry/reconnect and send ambiguity tested against each supported provider adapter.
9. Live tests explicitly identify provider, browser, and whether they used real accounts or a mock.
