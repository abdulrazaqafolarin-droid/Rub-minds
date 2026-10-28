# Backroom coordination v1 — wake planning, durable queue and runtime bridge

## Implemented experimental path
1. \`planWake\` checks group scope, participant state, participation mode, event type and selected draft binding.
2. \`createDispatcherCommand\` maps wake plans to the existing dispatcher contract; approval context binds command/event/group/participant/binding/host/space/session/target/revision/operation and SHA-256 of exact text.
3. \`SupabaseBackroomWakeStore\` is a server-only RPC adapter for the private queue migration. It validates every request/result and never exposes a service-role credential. It supports idempotent enqueue, bounded lease claims, acknowledgement, bounded retry, owner cancellation and expiry.
4. Each durable job stores a target identity fingerprint as well as group, host, space, session, binding, target ID and revision. Claims return a short-lived random lease token; only its SHA-256 digest is persisted.
5. \`commandFromClaimedWake\` resolves the exact registered target again and constructs a draft-only local command. \`dispatchClaimedWake\` checks the binding and participant, checks composer/foreground readiness, verifies an injected approval against the exact prompt digest, then uses the actual \`BackroomDispatcher\` and \`LocalExecutionGuard\`.
6. Successful draft insertion acknowledges the durable lease; safely retryable preflight conditions release it with delay. Stale bindings and ambiguous outcomes are never silently retargeted or blindly replayed.
7. The wake remains a prompt only. This bridge never submits or clicks Send. MCP event acknowledgement (the AI has read/responded to the group event) is a different lifecycle from queue acknowledgement (the host delivered/ignored the wake).

## Database boundary
- Migration: \`supabase/migrations/20261029090000_backroom_wake_queue.sql\`.
- SQL contract test: \`supabase/tests/backroom_wake_queue.sql\`.
- CI workflow: \`.github/workflows/backroom-wake-queue.yml\` applies the migration to an isolated PostgreSQL 17 service and runs the SQL lifecycle/privilege checks.
- Queue table and RPCs have RLS enabled, direct access revoked from \`public\`, \`anon\`, and \`authenticated\`, and execute grants limited to \`service_role\`.
- The table stores no provider cookies, tokens, raw conversation URLs, or plaintext lease token.
- The RPCs are privileged server-side building blocks. A trusted API/Edge Function must authenticate the paired host and owner before invoking claims or cancellation. Never expose a service-role client to browser or local untrusted code.
- The lease protocol is at-least-once, not exactly-once. The host must acknowledge promptly and keep its own idempotency record. UI effects that have an ambiguous outcome must be reconciled, not blindly replayed.
- This SQL migration has not been applied to production. Production must remain unchanged until isolated SQL CI passes and integration rollout is approved.

## Required next integration work
- Wire authoritative Supabase/MCP group events into the coordinator and call the durable store from a trusted server-side worker.
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
Keep PR #48 in draft until the clean test suite, isolated SQL workflow, real provider round-trip, host authentication, target revalidation, offline recovery and device-level acceptance have passed. No automatic Send or production migration is enabled by this PR.
