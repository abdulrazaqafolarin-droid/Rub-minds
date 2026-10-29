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

**This does not constitute automated participation yet.** The remote queue is not consumed by a paired host worker; the host's local wake grants are not mapped to the private database binding; the original ChatGPT/Claude session does not yet demonstrably execute MCP calls and acknowledge the pending group message. A local UI composer clearing proves only a DOM transition, not provider delivery.

**Validation:** The `Backroom durable wake queue SQL` GitHub Actions workflow was enabled for draft PRs, but the observed workflow run `40832920900` ended at runner level with **no job steps recorded** and no available logs. That result is not a PostgreSQL pass or fail. No independent PostgreSQL server is available in the current container. The SQL contract remains unverified and the feature is not safe to deploy. Keep the migration out of production.

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
- Implement the authenticated server-to-paired-host queue worker and bind each durable record to the current one-shot local host grant. The database now enqueues message events, but nothing claims and executes them automatically.
- Authenticate the Backroom host and map its signed pairing identity to a server-managed host/session digest.
- Implement the host-issued one-shot or scoped standing-consent approval service; the bridge deliberately accepts a trusted verifier callback instead of treating a boolean as proof.
- Provide atomic lease renewal or execution-state transitions if adapter effects may outlive the lease.
- Reconcile acknowledgements after host crashes and prevent duplicate inserts across host restarts.
- Prove a real Claude/ChatGPT MCP round trip and real Windows/Android/PTY acceptance. Simulated driver tests do not establish provider compatibility or native mobile app embedding.

## Focused Node tests
- \`npm run test:coordination\`
- \`npm run test:durable-queue\`
- \`npm run test:runtime\`
- \`npm run test:backroom\`

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

A Vercel preview for earlier commit `a8e6954` reported 135 runtime tests passing, and 22 focused coordinator/dispatcher integration tests passing; its frontend build succeeded. Those remote logs predate the canonical wake adapter, owner-scoped durable-queue hardening and latest tests. They do not validate current branch code or the SQL migration. The free Vercel API daily deployment limit currently prevents a newer preview. The latest PR-triggered GitHub Actions runs were **skipped because PR #48 remains a draft**; the isolated PostgreSQL 17 workflow result for the latest commit is not verified. The SQL contract is prepared in `supabase/tests/backroom_wake_queue.sql`, but must still pass a real isolated PostgreSQL run.

Do **not** apply this migration to production until the isolated SQL workflow succeeds, a clean-checkout test suite passes, and the actual server integration is implemented and validated. The RPCs are service-role-only, so the service endpoint must derive `owner_id` from an authenticated caller and validate the group participant/session binding; never trust those IDs from a browser request.

The SQL migration now creates message-triggered durable jobs, but the remote store and local opt-in wake API are still separate components: no trusted bridge delivers queued events to the paired local host. The production orchestrator must authenticate the host, map each binding to a live MCP session, poll/claim jobs, consume the one-shot wake grant, capture results and recover leases without duplicate sends before automated group-to-original-session participation is enabled.

## Paired worker integration slice (draft; not live)

`integrations/backroom/paired-wake-worker.mjs` now exposes a bounded single-pass `pollPairedWakeJobs` function. It claims a scoped batch through the private durable-store interface, rejects leases whose host ID, session digest or input binding differs from the expected connection, obtains current target/participant/binding and explicit approval through a **trusted** resolver, then calls the existing guarded `dispatchClaimedWake` path. Missing consent results in a non-dispatching bounded retry. It does **not** accept raw remote authentication tokens, create standing consent, perform pairing, host an HTTP endpoint, or independently make a privileged Supabase RPC client safe for distribution. These are mandatory responsibilities of a future server-authenticated transport and host runtime integration; the privileged RPC client must never be shipped to a browser or local untrusted endpoint.

Regression coverage is in `integrations/backroom/paired-wake-worker.node-test.mjs`, included in `test:runtime`, `test:backroom`, and `test:durable-queue`. The new tests are committed but have **not yet produced a successful independent execution result**; the SQL integration test likewise remains unverified. Do not merge or deploy on the strength of these additions alone.

## Authenticated remote queue boundary (draft)

`integrations/backroom/authenticated-wake-gateway.mjs` adds a trusted **server-side** authorization boundary for existing provisioned hosts. It compares SHA-256 of the presented 256-bit host token with the stored digest using constant-time comparison, verifies that the host is not expired or revoked, and loads the current binding independently from the database. A claim/ack/retry requires the exact same host, owner, binding and hosted MCP session digest; missing confirmation, disabled wake consent, expired consent and mismatched identities are denied without calling the private queue RPC. Denials deliberately use a uniform error. The gateway exposes no plaintext credential to the store.

**Not yet implemented:** pairing provisioning on the hosted service, a production HTTPS request handler, runtime delivery from the hosted server to the connected local device, restoration after restart, and a real MCP reply acknowledgement. `HostPairingAuthority` is the existing origin-bound *local* loopback mechanism and is not proof of a remotely authenticated host. This gateway must remain on the trusted hosted backend, where `lookupHost` and `lookupBinding` query authoritative records using server credentials. Remote callers must never supply their own host or binding record and must never receive a Supabase service-role key.

Tests: `authenticated-wake-gateway.node-test.mjs` exercises valid scope, wrong token/host/binding/session, expired/revoked/disabled/unconfirmed consent, and invalid limits; registered in `test:runtime`, `test:backroom` and `test:durable-queue`. These code-level tests are not yet independently evidenced as passing while GitHub-hosted runners fail before steps. SQL integration and true provider/device round trips remain release blockers.

## One-time execution journal (draft)

`FileWakeExecutionJournal` creates an atomic `wx` file under a private host-managed directory, syncing the seal to disk **before** the browser dispatcher executes a wake. The worker now rejects operation without a journal and seals each authorized target/session/job on the dispatcher execution step. A second attempt for the same job, including after process restart or DB lease expiry, does not repeat the provider-send action. The journal deliberately keeps sealed jobs instead of auto-deleting them; after crashes or ambiguous outcomes, an operator must reconcile and initiate a **new event** if needed. Operators must supply a private filesystem location with appropriate permissions; no user-provided path or web client path is acceptable. The existing local browser runtime must still be wired to this worker for any real protection. Queue acknowledgement is not proof of provider acceptance.

Tests: `file-wake-execution-journal.node-test.mjs` covers persistence, concurrent duplicate resistance and symlinked directories. These tests are registered but remain pending independent CI execution.
