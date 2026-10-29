# Backroom coordination v1 — wake planning, durable queue and runtime bridge

## Implemented experimental path
1. \`planWake\` checks group scope, participant state, participation mode, event type and selected draft binding.
2. \`createDispatcherCommand\` maps wake plans to the existing dispatcher contract; approval context binds command/event/group/participant/binding/host/space/session/target/revision/operation and SHA-256 of exact text.
3. \`SupabaseBackroomWakeStore\` is a server-only RPC adapter for the private queue migration. It validates every request/result and never exposes a service-role credential. It supports idempotent enqueue, bounded lease claims, acknowledgement, bounded retry, owner cancellation and expiry.
4. Each durable job stores a target identity fingerprint as well as group, host, space, session, binding, target ID and revision. Claims return a short-lived random lease token; only its SHA-256 digest is persisted.
5. \`commandFromClaimedWake\` resolves the exact registered target again and constructs a draft-only local command. \`dispatchClaimedWake\` checks the binding and participant, checks composer/foreground readiness, verifies an injected approval against the exact prompt digest, then uses the actual \`BackroomDispatcher\` and \`LocalExecutionGuard\`.
6. Successful draft insertion acknowledges the durable lease; safely retryable preflight conditions release it with delay. Stale bindings and ambiguous outcomes are never silently retargeted or blindly replayed.
7. The generic `draft` operation remains draft-only. The separate `wake` operation may submit only the exact canonical `@RMconnects` prompt, and only after an explicit scoped grant. `BrowserCanonicalWakeAdapter` is restricted by the managed host to the Claude/ChatGPT HTTPS origins, checks the exact selected composer and uniquely identified send control, and waits up to eight seconds for that conversation's composer to clear. An uncertain submit returns `needs_review` and is never retried automatically. This does not prove that the provider model completed a response. MCP event acknowledgement (the AI has read/responded to the group event) remains separate from queue acknowledgement (the host attempted the wake).

## Local managed-browser wake operation

- The loopback host exposes authenticated, origin-bound `POST /v1/browser/wake/grants`, `POST /v1/browser/wake/grants/revoke`, and `POST /v1/browser/wake` endpoints.
- A grant requires explicit confirmation, binds one group/participant/session/binding/target revision/identity fingerprint, expires within 15 minutes by default, and is rate-limited (six wake attempts per minute by default). Grants are revoked when the target disappears, the browser closes, the host stops or the grant is explicitly revoked.
- The wake adapter never accepts caller-authored text. It builds the fixed trigger from a validated event ID; no private group message body or arbitrary prompt is injected into the original AI conversation.
- These endpoints currently support explicit local trigger operations. The Supabase message trigger/coordinator, host-pairing record, remote queue poller, automatic response capture and MCP round-trip are not wired end-to-end yet. A durable wake row by itself does not wake a local device.

## Message-trigger milestone (feature branch only)

The queue migration now includes a **PostgreSQL AFTER INSERT trigger on `public.messages`**. It reads only the authoritative saved message ID, room, sender, and body for mention matching; the queued prompt contains only the message ID and the fixed `@RMconnects` instructions, **never the body**. It suppresses self-wakes, checks the AI participant's current room membership, room ownership, nonrevoked `agent_connections` and live MCP session, and checks an active consented host/input binding. `mentions` mode looks for a bounded `@display_name` mention; `smart` handles any other participant's message; `task` waits for an actual task event source (not wired into the message trigger). The trigger catches enqueue failure so a user-authored message still commits. It enforces a maximum six queued wake jobs per input binding per minute, with a 100-pending-job backlog ceiling.

**The source-level integration path is present, but automated participation is not yet proven end-to-end.** The branch includes an authenticated host gateway, HTTPS handler, Supabase Edge Function, remote queue client, paired worker, local poller, consent-scoped host service, owner UI configuration, and host/binding revocation. The committed Node runtime and Backroom suites now pass in an isolated Node 22 sandbox, and the draft migration plus full SQL acceptance file passed in a PGlite PostgreSQL-compatible runtime. The native PostgreSQL 17 GitHub Actions job still fails before any steps are recorded, so that gate remains blocked. The Edge Function has not been verified in a staging Deno/Supabase deployment, and a real ChatGPT/Claude MCP round trip has not been demonstrated. A local UI composer clearing proves only a DOM transition, not provider delivery.

**Historical validation note:** Earlier GitHub Actions runs failed before any steps were recorded and their log retrieval returned `BlobNotFound`; that did not prove a SQL or Node assertion failed. The current evidence is recorded in **Validation record — 2026-10-29** below: the full committed runtime and Backroom Node suites pass, and the SQL migration plus acceptance file pass in PGlite. Native PostgreSQL 17 workflow execution remains blocked. Keep the migration out of production.

## Database boundary
- Migration: \`supabase/migrations/20261029090000_backroom_wake_queue.sql\`.
- SQL contract test: \`supabase/tests/backroom_wake_queue.sql\`.
- CI workflow: \`.github/workflows/backroom-wake-queue.yml\` applies the migration to an isolated PostgreSQL 17 service and runs the SQL lifecycle/privilege checks.
- Queue table and RPCs have RLS enabled, direct access revoked from \`public\`, \`anon\`, and \`authenticated\`, and execute grants limited to \`service_role\`.
- The table stores no provider cookies, tokens, raw conversation URLs, or plaintext lease token.
- The RPCs are privileged server-side building blocks. Enqueue verifies the room owner, active AI participant, live MCP session and non-revoked `agent_connections` record; claims/acknowledgements/retries also require that live authorization record. A trusted API/Edge Function must still authenticate the paired local host before invoking claims or cancellation. Never expose a service-role client to browser or local untrusted code.
- The lease protocol is at-least-once, not exactly-once. The host must acknowledge promptly and keep its own idempotency record. UI effects that have an ambiguous outcome must be reconciled, not blindly replayed.
- This SQL migration has not been applied to production. Production must remain unchanged until isolated SQL CI passes and integration rollout is approved.

## Required next integration work

- The committed Node runtime and Backroom suites have passed in an isolated Node 22 sandbox. Obtain a clean, independently observable GitHub Actions run of the isolated PostgreSQL 17 migration contract; current workflow jobs fail before recording steps, so native PostgreSQL CI is still unverified.
- Deploy the migration and Edge Functions only to a separate nonproduction Supabase project; exercise registration, renewal, binding, consent activation, claim, acknowledgement, deactivation, and remote revocation over HTTPS.
- Test local host restart recovery, one-time execution journal, target revalidation, concurrency, expiry, revocation races, and ambiguous provider effects.
- Demonstrate a real ChatGPT and Claude MCP round trip: the invited session reads an authorized group event, responds to the group, and acknowledges it. Composer clearing or queue acknowledgement alone is insufficient evidence.
- Complete device-level acceptance for Windows, desktop, Android, and terminal targets. The native and terminal adapters currently provide draft-only contracts, not installed OS drivers or proof of native app embedding.

## Focused Node tests
- `npm run test:multi-surface` — native/terminal draft-only safety contracts.
- `npm run test:host-lifecycle` — host identity, consent lifecycle, remote transport and binding policy.
- `npm run test:coordination`
- `npm run test:durable-queue`
- `npm run test:runtime`
- `npm run test:backroom`

## Release gate
Keep PR #48 in draft until the clean test suite, isolated SQL workflow, real provider round-trip, host authentication, target revalidation, offline recovery and device-level acceptance have passed. Only the explicitly opted-in canonical wake can submit; generic drafting remains draft-only. No production migration or production deployment is enabled by this PR.

## Durable wake queue milestone

The experimental Supabase migration `20261029090000_backroom_wake_queue.sql` adds a private, RLS-enabled wake-job table and service-role-only RPCs:
- Idempotent enqueue that rejects reuse of a key for different content.
- Jobs bound to owner, group, participant, host, runtime space, original session, target ID, target identity fingerprint and target revision.
- A digest of the exact wake prompt and bounded expiry.
- Atomic leases using `FOR UPDATE SKIP LOCKED`; plaintext lease tokens are returned only to the trusted backend while only SHA-256 digests are stored.
- Per-session admission locking and a 100-job active backlog ceiling; duplicate/idempotent requests remain retryable at capacity.
- Token-bound acknowledgement, bounded retry, owner-scoped cancellation, expiry processing, and bounded purge of terminal jobs older than the configured retention period.
- Retry and claim limits intended to prevent infinite work.

The server-only `durable-wake-store.mjs` adapter maps enqueue/claim/ack/retry/cancel/expire/purge RPCs, validates the identity-bound lease metadata and exact prompt SHA-256, rejects a missing/expired/replayed retry lease, and accepts only the canonical newline-delimited wake prompt while rejecting other control bytes. `durable-coordinator.mjs` now routes only policy-eligible events into that durable queue after confirming the participant, group, selected target, session, target revision and draft capability. Its tests use a mocked Supabase RPC client and do not execute PostgreSQL.

## Validation status / release discipline

A Vercel preview for earlier commit `a8e6954` reported 135 runtime tests passing and 22 focused coordinator/dispatcher integration tests passing, but those logs predate the current queue and host-lifecycle changes. Current-source validation is recorded in **Validation record — 2026-10-29** below: `npm run test:runtime` passed 367/367, `npm run test:backroom` passed 254/254, and `npm run build` passed. The current Vercel check is blocked by `build-rate-limit`, so no newer preview was produced. GitHub Actions still reports failed jobs with zero steps and unavailable logs; the native PostgreSQL 17 result remains unverified.

Do **not** apply this migration to production until the isolated SQL workflow succeeds, a clean-checkout test suite passes, and the actual server integration is implemented and validated. The RPCs are service-role-only, so the service endpoint must derive `owner_id` from an authenticated caller and validate the group participant/session binding; never trust those IDs from a browser request.

The SQL message trigger, remote store, host wake service, paired worker, local poller and owner-facing configuration now exist in source. They have focused mocked/isolated tests, but the live Edge Function, persisted queue, host daemon, browser UI and provider conversation have not been verified together in a staging environment. Before enabling automated group-to-original-session participation, test the complete authenticated route end to end, including grant consumption, acknowledgement, lease recovery, revocation races and prevention of duplicate sends.

## Paired worker integration slice (draft; not live)

`integrations/backroom/paired-wake-worker.mjs` now exposes a bounded single-pass `pollPairedWakeJobs` function. It claims a scoped batch through the private durable-store interface, rejects leases whose host ID, session digest or input binding differs from the expected connection, obtains current target/participant/binding and explicit approval through a **trusted** resolver, then calls the existing guarded `dispatchClaimedWake` path. Missing consent results in a non-dispatching bounded retry. It does **not** accept raw remote authentication tokens, create standing consent, perform pairing, host an HTTP endpoint, or independently make a privileged Supabase RPC client safe for distribution. These are mandatory responsibilities of a future server-authenticated transport and host runtime integration; the privileged RPC client must never be shipped to a browser or local untrusted endpoint.

Regression coverage is in `integrations/backroom/paired-wake-worker.node-test.mjs`, included in `test:runtime`, `test:backroom`, and `test:durable-queue`. The tests are committed but have **not yet produced a successful independently observable run**; the SQL integration test likewise remains unverified. Do not merge or deploy on the strength of these additions alone.

## Authenticated remote queue boundary (draft)

`integrations/backroom/authenticated-wake-gateway.mjs` adds a trusted **server-side** authorization boundary for existing provisioned hosts. It compares SHA-256 of the presented 256-bit host token with the stored digest using constant-time comparison, verifies that the host is not expired or revoked, and loads the current binding independently from the database. A claim/ack/retry requires the exact same host, owner, binding and hosted MCP session digest; missing confirmation, disabled wake consent, expired consent and mismatched identities are denied without calling the private queue RPC. Denials deliberately use a uniform error. The gateway exposes no plaintext credential to the store.

**Source exists; live deployment is unverified:** the owner-authenticated `backroom-config` Edge Function supports host registration/renewal, input binding and remote revocation; `backroom-wake` mounts the authenticated queue gateway; the local host service configures per-binding pollers. None of these paths has been proven in a deployed nonproduction environment. `HostPairingAuthority` remains an origin-bound local loopback mechanism, not proof of remote identity. The gateway must stay on the trusted hosted backend and query authoritative host/binding records with server credentials. Remote callers must never supply their own host or binding record or receive a service-role key.

Tests: `authenticated-wake-gateway.node-test.mjs` exercises valid scope, wrong token/host/binding/session, expired/revoked/disabled/unconfirmed consent, and invalid limits; registered in `test:runtime`, `test:backroom` and `test:durable-queue`. These code-level tests are not yet independently evidenced as passing while GitHub-hosted runners fail before steps. SQL integration and true provider/device round trips remain release blockers.

## One-time execution journal (draft)

`FileWakeExecutionJournal` creates an atomic `wx` file under a private host-managed directory, syncing the seal to disk **before** the browser dispatcher executes a wake. The worker now rejects operation without a journal and seals each authorized target/session/job on the dispatcher execution step. A second attempt for the same job, including after process restart or DB lease expiry, does not repeat the provider-send action. The journal deliberately keeps sealed jobs instead of auto-deleting them; after crashes or ambiguous outcomes, an operator must reconcile and initiate a **new event** if needed. Operators must supply a private filesystem location with appropriate permissions; no user-provided path or web client path is acceptable. The existing local browser runtime must still be wired to this worker for any real protection. Queue acknowledgement is not proof of provider acceptance.

Tests: `file-wake-execution-journal.node-test.mjs` covers persistence, concurrent duplicate resistance and symlinked directories. These tests are registered but remain pending independent CI execution.

## Trusted HTTPS route adapter (draft, not deployed)

`wake-gateway-http.mjs` implements a small portable Request/Response handler for `POST /v1/backroom/wake/claim`, `/ack`, and `/retry`. The bearer is taken **only** from the Authorization header; the handler rejects non-HTTPS requests, URL query strings, unexpected fields, browser Origin and Cookie headers, missing/malformed bearer credentials, non-JSON bodies and oversized requests. It returns no CORS grants, sets `Cache-Control: no-store`, and redacts internal server exceptions. This handler delegates all identity checks to the authoritative server-side `createAuthenticatedWakeGateway` module.

**Important:** This route is a library for a server runtime, not a deployed Supabase Edge Function or Vercel route. The live remote host provisioning process, live HTTPS mount, host daemon HTTP polling, persistent authorized approval resolution and real provider MCP round trip are not yet connected. Do not enable the route publicly without request rate limiting, TLS termination and integration tests in its actual hosting environment.

## Remote host transport and Supabase Edge deployment boundary

The branch now includes `remote-wake-store.mjs`, an **unprivileged local host HTTPS client** that performs scoped claim, acknowledgement and bounded retry with a 15-second request deadline; it refuses HTTP origins, URL credentials, query tokens and cross-scope leases. The matching `supabase/functions/backroom-wake/index.ts` Edge Function uses its **server-held** Supabase service-role key for the restricted private queue RPCs, while `authenticated-wake-gateway.mjs` verifies an already registered host token against its digest and confirms current host/binding ownership, expiry and opt-in wake consent. `wake-gateway-http.mjs` provides bounded, non-CORS, no-cache HTTP request handling. `supabase/config.toml` sets `verify_jwt=false` for **this function only**, because the incoming bearer is an independent randomly generated host credential, **not** a Supabase Auth JWT; the handler must authenticate it itself. Supabase documents this custom-auth pattern for Edge Functions.

The transport has a fake-fetch integration test across host client -> HTTP handler -> host/binding gateway -> mocked private queue RPC, including denied credentials and exact Supabase Function URLs. A local Node 22 mirror of the new transport/gateway/journal/handler suite passed 15/15 test cases after correcting one malformed denial-test fixture. This **does not** mean the Edge Function has been deployed or run in the Deno runtime, nor that native PostgreSQL 17 CI has passed. A later isolated PGlite run successfully applied the draft wake-queue migration and executed the full SQL acceptance file; that is useful SQL integration evidence, but it is not a substitute for the repository's PostgreSQL 17 GitHub Actions job. Repeated GitHub Actions runs still report failed jobs with no recorded steps, and the job-log endpoint returns `BlobNotFound`, so the CI startup failure itself remains undiagnosed.

**Owner setup code exists, but live setup is unverified:** the signed-in UI can register/renew a host, create an inactive selected-input binding, configure the local host with the public Supabase project key, and permanently revoke a host or binding. Remote revocation clears consent and cancels queued/leased jobs; rotate a revoked local identity with `npm run backroom:rotate-host` before re-registering. The host token remains private to the local host process; the public project key does not authorize a host by itself. Test against an isolated nonproduction Supabase project and real ChatGPT/Claude sessions before changing production.

  
## Host restart and identity rotation safety

- Local hosted-wake binding configuration is process-local unless all three documented headless environment values are provided. The host never enables a wake grant just because configuration is present.
- Rotating the local host identity creates a private `host-identity.json.rotation-pending` marker before replacing the old identity. On subsequent starts, the host suppresses inherited `BACKROOM_WAKE_SESSION_DIGEST`, `BACKROOM_WAKE_BINDING_ID`, and `BACKROOM_WAKE_PUBLISHABLE_KEY` values while that marker exists; an old binding cannot be silently reattached to the rotated identity.
- After rotation, re-register the new host and create/select a fresh authorized binding through the signed-in Rub Minds UI. The marker is intentionally persistent. Remove it only after reviewing and replacing all headless values with a fresh, authorized binding; do not remove it to make an old binding work again.
- The marker is a local safety guard, not proof that the previous remote host was revoked. Revoke the old host through the authenticated server endpoint before rotating. Remote revocation and SQL queue behavior still require isolated-database acceptance testing before release.

  
## Validation record — 2026-10-29

This record refers to source branch `feat/backroom-coordination-core-v1`, including the nullable binding-conflict fix `b9e73bd7015723eeff8c4f7b2129c793eadd0523` and atomic browser route-race fix `20a794b229aa54423a7db7a2f4c0c8a2564f1e21`. Checks ran in disposable Node 22.23.4 workspaces and are not a production release. Subsequent commits on this branch reconcile validation evidence and documentation.

| Check | Evidence | Status |
|---|---|---|
| Clean dependency install | `npm ci --no-audit --no-fund` completed successfully | Pass |
| Runtime Node suite | `npm run test:runtime`: 367 tests, 367 passed, 0 failed | Pass |
| Backroom Node suite | `npm run test:backroom`: 254 tests, 254 passed, 0 failed | Pass |
| TypeScript + production bundle | After the final UI type fix, `tsc -b --pretty false` and `vite build` were run separately and both exited 0. The prereq runtime/Backroom suites passed separately; the `npm run build` lifecycle wrapper was not rerun as one command after that final edit. | Component gates pass |
| Host lifecycle subset | `npm run test:host-lifecycle`: 32 passed, 0 failed | Pass |
| Coordination subset | `npm run test:coordination` on the current code: 35 passed, 0 failed | Pass |
| Application unit tests | `npm test -- --reporter=dot`: 25 tests across 4 files, 0 failed | Pass |
| Multi-surface subset | `npm run test:multi-surface`: 31 passed, 0 failed | Pass |
| Local host server contract | `node --test integrations/backroom/host-server.node-test.mjs`: 31 passed, 0 failed | Pass |
| Host identity | `node --test integrations/backroom/host-identity.node-test.mjs`: 7 passed, 0 failed | Pass |
| Draft SQL migration and acceptance file | Isolated PGlite PostgreSQL-compatible instance: clean fixture setup, migration application, and all statements in `supabase/tests/backroom_wake_queue.sql` completed without error | Pass, compatibility runtime only |
| Native PostgreSQL 17 workflow | Across repeated recent branch runs, including `40871918872`, `40871919130`, `40872181606`, and `40872181648`, jobs failed with empty step lists and job-log retrieval returned `BlobNotFound`. No SQL assertion or workflow command can be confirmed to have run. | Blocked before execution |
| Real Chromium acceptance | Three browser acceptance files ran against real Chromium in the disposable Node 22 sandbox after using bundled AL2023 libraries and fonts (`LD_LIBRARY_PATH=/tmp/al2023/lib`, `FONTCONFIG_PATH=/tmp/fonts`) and a sandbox-only preload for the injected persistent-browser provider. **8 tests passed, 0 failed**, including the local-host/Playwright end-to-end path and no-send checks. | Pass (controlled browser only) |
| ChatGPT / Claude session round trip | No direct provider session was authorized and verified end to end in this run | Not tested |
| Production | No production deployment or production migration was run | Unchanged |

The full Node suites and the build passed after fixing the content-type regex, invalid test expectations, persistent rotation-marker guard, and the TypeScript optional-reason narrowing error. The targeted SQL run found and corrected a mismatch where binding revocation was explicitly idempotent in SQL but its acceptance test expected a retry to return false.

**Release decision:** keep PR #48 in draft. Do not deploy the migration or claim provider integration is live until native PostgreSQL 17 CI has a successful execution with real step logs, the Edge Functions are verified in Deno/Supabase staging, and real ChatGPT plus Claude tool/session round trips are observed separately. Controlled-browser acceptance passed, but it is not provider interoperability evidence.

## Browser acceptance follow-up — 2026-10-29

- A real Chromium run of the three browser acceptance files passed **8/8 tests** after fixing the route-change rejection defect in `integrations/backroom/browser-draft-adapter.mjs` (commit `20a794b229aa54423a7db7a2f4c0c8a2564f1e21`). The defect returned a nested object instead of the expected `conversation_changed` state string, allowing the race guard to return a review result rather than rejecting the stale route.
- Isolated Node 22 / Amazon Linux verification used `@sparticuz/chromium` with bundled `al2023` libraries, `LD_LIBRARY_PATH=/tmp/al2023/lib`, `FONTCONFIG_PATH=/tmp/fonts`, and `CHROMIUM_PATH=/tmp/chromium`. Because the end-to-end test's injected Playwright provider does not read `CHROMIUM_PATH`, the test-only sandbox preload supplied the compatible Chromium `executablePath` to `chromium.launchPersistentContext`; no repository product code or test assertions were changed for this environment compatibility step.
- Browser-draft, selection-overlay, and local-host end-to-end tests passed in controlled local pages. These do **not** test real logged-in ChatGPT/Claude sessions, customer account permissions, production tool integration, or remote server grant revocation.
- The earlier browser-environment blocker is superseded by the passing controlled Chromium run recorded above. Native PostgreSQL CI, Deno/Edge staging validation, provider interoperability, and production authorization remain release blockers.

## Chromium acceptance follow-up — 2026-10-29

In a disposable Amazon Linux Node 22 sandbox, Chromium initially crashed because `libnspr4.so` was absent. A separate packaged Chromium binary plus its included `al2023.tar.br` libraries resolved this dependency. A subsequent browser failure was traced to missing Fontconfig configuration (`SkFontMgr_FontConfigInterface.cpp: Not implemented`); the packaged font archive supplied `/tmp/fonts/fonts.conf`.

With environment variables `CHROMIUM_PATH=/tmp/chromium`, `LD_LIBRARY_PATH=/tmp/al2023/lib`, and `FONTCONFIG_PATH=/tmp/fonts`, the unmodified test command `node --test integrations/backroom/browser-draft.browser-test.mjs` completed **1 test, 1 passed, 0 failed**. It is a real controlled Chromium composer, **not** a real ChatGPT or Claude session. The overlay and host E2E browser cases have **not** been confirmed passing; the temporary sandbox stopped before those runs. The overall browser test gate therefore remains unpassed, despite the corrected draft subtest.
