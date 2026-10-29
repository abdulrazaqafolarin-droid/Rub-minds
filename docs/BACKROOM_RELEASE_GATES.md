# Rub Minds Backroom — release evidence and acceptance gates

Last audited: 2026-10-29. Scope: draft PR #48, based on draft PR #47. **NOT APPROVED FOR RELEASE**.

## Implemented on feature branch

- Database migration adds private host records, opt-in target bindings, bounded durable queue, scoped lease RPCs, and a message-insert wake trigger.
- Hosted server entrypoint: `supabase/functions/backroom-wake/index.ts`. The service-role key stays on the server. It does not accept browser cookies or browser Origin credentials.
- Host authentication: credential digest compared with a constant-time check, active host/owner/binding/MCP session scope, expiry and consent checked before claims, retries and acknowledgements.
- HTTP transport: HTTPS-only, no credential-bearing URL, no redirects, bounded request body, no CORS, no-cache and generic failure response.
- Local process client: bounded HTTPS poll/ack/retry, exact Supabase Function path, scope checks and a network deadline.
- Local wake worker: group/host/participant/session/input-target matching, explicit verified grant, selected target revalidation and guarded dispatcher.
- Durable execution journal: atomically reserves a wake immediately before any UI effect, refuses duplicate reservation across restarts, rejects symlinked and nonprivate directories; no automatic resends on ambiguous outcomes.
- Stable private host identity: the host runner now reuses a 256-bit local credential and UUID across restarts, storing only its digest in enrollment output; secret persists under the user's private Backroom directory.\n- Node regression suites registered in package scripts; mocks do not demonstrate real ChatGPT/Claude MCP conversations.

## Evidence

- Read-only live Supabase schema check confirmed `rooms`, `participants`, `messages`, `agent_connections`, `rub_minds_mcp_sessions` and key primary/unique constraints exist. The new Backroom queue schema was not present.
- Locally reconstructed Node 22 tests of host authentication, identity persistence, journal, HTTP boundary and remote-transport integration: **20 passed / 0 failed**. This is a **mirror of the code**, not an original-branch checkout execution and not an Edge Function runtime execution.
- Draft GitHub Actions build job is skipped. The isolated Postgres Actions job repeatedly fails with `steps: null` before any test runs. This is **not** evidence that migration SQL compiled or passed.
- No PostgreSQL 17 migration/trigger tests, live provider round trip, app build, independent security penetration test or real Windows/Android acceptance run has passed in this sprint.
- No database migration, Edge Function or Vercel release was deployed to production.

## Mandatory release gates (all must be green)

- [ ] Finish authenticated owner-to-host enrollment, selected target/binding registration and consent activation without leaking host or Supabase credentials.
- [ ] Integrate remote queue polling in the actual local Backroom host process; handle stop/unpair/revocation, offline recovery, renewal and restart.
- [ ] Ensure the true dispatcher uses the persistent execution journal and only consumes a grant for the exact selected target.
- [ ] Run fresh PostgreSQL 17 migration/trigger tests against an isolated instance with realistic fixtures and privilege checks.
- [ ] Run full Node/Vite/TypeScript build, Backroom suite and browser automation suite on the actual GitHub branch.
- [ ] Run live ChatGPT and Claude acceptance: group message -> queue -> local host -> original AI session -> MCP fetch -> AI group reply -> MCP acknowledgement, including reboot and revocation tests.
- [ ] Resolve mobile/native capability claims using verified device tests; mark unavailable capabilities unavailable instead of simulating success.
- [ ] Resolve security-advisor warnings before release as appropriate; distinguish intentionally exposed authenticated definer RPCs from privilege escalation.
- [ ] Review dependent PR #47, then PR #48, merge only with green gates and complete a controlled staging deployment before production.

## Explicit no-go conditions

Never ship merely because a composer cleared, a durable job was acknowledged, a browser-click simulation succeeded, or GitHub marked a draft branch mergeable. None of these independently proves that the original provider session read and responded to the group event. Avoid automatic retry after uncertain UI submission. Leave production unchanged until the above evidence exists.
