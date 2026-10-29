# Rub Minds Backroom — release evidence and acceptance gates

Last audited: 2026-10-29. Scope: draft PR #48, based on draft PR #47. **NOT APPROVED FOR RELEASE**.

## Implemented on feature branch

- Database migration adds private host records, opt-in target bindings, a persisted wake-grant ID with consistent consent-state constraints, bounded durable queue, scoped lease RPCs, and a message-insert wake trigger. Enqueue/claim/ack now require an actively connected AI participant as well as a live MCP session and agent connection.
- Hosted server entrypoint: `supabase/functions/backroom-wake/index.ts`. The service-role key stays on the server. It does not accept browser cookies or browser Origin credentials.
- Host authentication: credential digest compared with a constant-time check, active host/owner/binding/MCP session scope, expiry and consent checked before claims, retries and acknowledgements. The local host pins the private-token destination to the Rub Minds Supabase Edge URL; the paired browser may submit only binding ID and session digest.
- HTTP transport: HTTPS-only, no credential-bearing URL, no redirects, bounded request body, no CORS, no-cache and generic failure response.
- Local process client: bounded HTTPS poll/ack/retry, exact Supabase Function path, scope checks and a network deadline.
- Local wake worker: group/host/participant/session/input-target matching, explicit verified grant, selected target revalidation and guarded dispatcher.
- Durable execution journal: atomically reserves a wake immediately before any UI effect, refuses duplicate reservation across restarts, rejects symlinked and nonprivate directories; no automatic resends on ambiguous outcomes.
- Stable private host identity: the host runner now reuses a 256-bit local credential and UUID across restarts, storing only its digest in enrollment output; secret persists under the user's private Backroom directory.\n- Node regression suites registered in package scripts; mocks do not demonstrate real ChatGPT/Claude MCP conversations.

## Evidence

- Read-only live Supabase schema check confirmed `rooms`, `participants`, `messages`, `agent_connections`, `rub_minds_mcp_sessions` and key primary/unique constraints exist. The new Backroom queue schema was not present.
- Locally reconstructed Node 22 tests of host authentication, identity persistence, journal, HTTP boundary and remote-transport integration: **24 passed / 0 failed**. This is a **mirror of the code**, not an original-branch checkout execution and not an Edge Function runtime execution.
- Latest GitHub Actions runs (`Validate Rub Minds` and `Backroom durable wake queue SQL`) report failures with empty `steps` arrays and no downloadable logs (`BlobNotFound` from the log endpoint). Build, local Supabase and SQL jobs therefore provide **no test result**; this is not evidence that the code or migration passed or failed within a command.
- No PostgreSQL 17 migration/trigger tests, live provider round trip, app build, independent security penetration test or real Windows/Android acceptance run has passed in this sprint.
- No database migration, Edge Function or Vercel release was deployed to production.

- Latest host wake service regression suite: **10/10 passed** in a custom isolated JavaScript harness using the actual branch `host-wake-service.mjs` and `remote-wake-store.mjs`; poller, filesystem, timer and response/network dependencies were controlled mocks. This validates host-service control-flow and request contracts, not a real Node runner, TLS, Supabase, Deno or PostgreSQL.
- Added PostgreSQL integration assertions for expired-grant recovery: a fresh local grant must be able to replace an expired persisted grant after a host crash, while a stale grant must not revoke the replacement. This SQL test remains **unexecuted** because the GitHub job has no steps/logs.
- Added a host-server regression proving the API reports local stop and uncertain remote deactivation separately; this new committed test has not yet run on a clean Node checkout.

- The local-to-hosted credential route was explicitly reviewed and hardened: browser-controlled HTTPS origins are rejected; default destination is the known Rub Minds Supabase function; the hosted grant ID is persisted and used for idempotent activation/deactivation. These safeguards have source tests committed, but Deno/PostgreSQL runtime evidence remains pending.

## Mandatory release gates (all must be green)

- [ ] Validate and integrate new owner JWT-gated enrollment + inactive input binding endpoint (`backroom-config`) with the authenticated local browser UI and live backend. The host-only activation path is implemented but must be proven against real local grants, revocation and Deno runtime. Never send raw host credentials to the browser.
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

## Host registration and consent activation slice (draft)

The host now retains a private UUID/256-bit credential across local runtime restarts. The origin-bound paired browser can read **only the host credential digest** from the authenticated `GET /v1/host` status response. New Supabase `backroom-config` Edge routes authenticate the signed-in **human owner JWT**, register a digest-only host and create a database input binding **inactive by default**. Registration rejects client-provided `wakeEnabled`, `confirmedAt`, unexpected fields and raw host tokens.

The separate hosted `backroom-wake/activate` route requires the authenticated host bearer and is bounded to 60–900 seconds. `remote-wake-store.activate` refuses to call it without an injected local grant verifier that returns true for the exact host/session/binding/grant scope; the live browser dispatcher must still consume the actual scoped grant before UI execution. The gateway activation handler performs an authoritative database update and does not accept browser-origin calls. These endpoints have not been deployed, and the new Edge Function itself has not been Deno- or database-integration tested.

Locally mirrored Node test suites for gateway/activation, transport, HTTP, enrollment validation, stable host identity and execution journal previously passed **24 of 24**. A separate new host-server test for the paired status digest is committed but **not yet independently executed**. Database SQL migration tests, full runtime CI and live ChatGPT/Claude acceptance remain red/unverified.

## Multi-surface execution foundation

`integrations/backroom/multi-surface-execution.mjs` supplies a shared, draft-only registry and guarded executor for native desktop, Windows, Android and terminal input targets. It is an opt-in host service and **does not install an OS-specific accessibility or PTY driver**. The local host API can list registered native targets and request a permission-checked draft only when a trusted multi-surface runtime has been installed; otherwise it fails closed. Browser automation remains owned by its dedicated Playwright runtime.

Cross-surface regression tests have been committed and added to `test:runtime` and `test:backroom`; additional host-server cases check authentication and refusal of browser-supplied driver registration. Both the new coordinator and test file passed an isolated V8 JavaScript syntax check, but a clean full Node test run on the actual repository is **not yet available**. See `docs/BACKROOM_MULTI_SURFACE_AUTOMATION.md` for the matrix and device acceptance requirements.

## Lifecycle hardening update (draft, not deployed)

- **Credential destination pinning and Supabase API gateway:** browser-provided remote gateway URLs are rejected. The local host uses the known Rub Minds Supabase Edge endpoint unless the local process owner explicitly configures a trusted alternate endpoint in the host process environment. The local client supplies the project's public publishable/anon key in the required `apikey` header and the private host bearer separately in `Authorization`; neither is placed in the URL or request JSON. Private host bearer credentials are never sent to a URL supplied by the web page.
- **Activation/revocation race control:** each activated binding persists a `wake_grant_id`. The database accepts repeated activation only for the same active grant; deactivation clears grant, confirmation and expiry atomically and only when the exact grant ID matches. A previous grant cannot deactivate a newer consent.
- **Bounded consent lifetime:** hosted consent lifetime is calculated from the remaining local grant time with a safety margin. The host automatically stops polling at local grant expiry, retries only the same idempotent grant after a lost activation response, and best-effort retries deactivation while local polling is already stopped.
- **Active participant requirement:** queue enqueue/claim/ack/retry paths and owner binding discovery require a connected/active/autonomous AI participant in addition to an unexpired MCP session and agent connection.
- **Remote host revocation and recovery:** an owner-JWT-only configuration route invokes the private atomic `revoke_backroom_host` RPC, which revokes the host, every binding and all pending/leased jobs. Host renewal is idempotent only for the same owner and credential digest. After permanent revocation, stop the local host and run `npm run backroom:rotate-host` to create a new identity before registering again.

Tests were added for gateway URL injection, grant-specific deactivation, lost-response activation retry, credential rotation, active participant queue fixtures, and atomic database revocation. The actual branch-level Node/PostgreSQL suites and Edge Function Deno runtime still have not produced clean CI evidence because the GitHub Actions jobs are failing with empty step lists and no job-log URL; no production migration or Edge Function deployment has occurred. Treat all hosted lifecycle behavior as unverified until those tests execute in a real runner.

## Single-input binding revocation and idempotent rebind (draft)

A separate owner-JWT endpoint `backroom-config/revoke-binding` calls the private `revoke_backroom_input_binding` transaction. It clears that binding's wake enabled/grant/confirmation/expiry state, marks the binding revoked, and cancels all pending or leased jobs for it, without revoking other bindings on the same host. The owner UI first stops the local poller when reachable, then revokes that exact server binding. If the host is offline, the server-side revoke still invalidates future claims and cancels its queue entries.

Registration uses `binding-registration-policy.mjs`: an exact existing **inactive** binding is reused idempotently; a changed input fingerprint, target revision, room/session or target ownership requires explicit revoke before rebind; active consent is never overwritten by a registration request. Inconsistent overlapping reservations force the full-host repair path rather than picking a target silently. The extracted pure policy's **7/7 tests passed** in the isolated JavaScript harness. SQL revocation integration fixtures and host HTTP stop/configure fixtures are committed; PostgreSQL CI and live Edge Function acceptance remain unverified.
