# Backroom coordinator — execution contract v1

This experimental milestone connects group wake planning to the Backroom dispatcher contract. It is not yet an unattended ChatGPT/Claude integration, a universal Android app container, or a production durable wake-up service.

## Implemented path
1. `planWake` checks group scope, participant state, participation mode, event type and selected draft binding.
2. `createDispatcherCommand` maps the wake plan to the existing dispatcher fields and a registered target's group, host, space, session, identity fingerprint and revision.
3. `enqueueWakePlan` queues a draft-only command. It never executes the adapter.
4. `approvalContext` binds a one-shot approval to command/event/group/participant/binding/host/space/session/target/revision/operation and a SHA-256 digest of the exact prompt.
5. `dispatchApprovedWake` calls an injected verifier. That verifier must confirm the requesting user/device authority and atomically consume the exact approval ticket; accepting a caller-provided boolean is not sufficient.
6. The existing dispatcher re-resolves the target revision; the local execution guard rechecks connection, permissions, focus and app/session identity.
7. The adapter returns a verified draft outcome. This bridge never submits or clicks Send.

## Safety boundary
- `@RMconnects` is a wake-up instruction, not an authentication token.
- The bridge is draft-only; no submit action is enabled.
- Do not overwrite non-empty user drafts. Each platform adapter must recheck composer state at effect time.
- Group, participant, session, target, revision and identity must agree.
- The approval verifier must be server/host trusted, parameter-bound and one-shot.
- The dispatcher and bridge's pending-record map are in-process. Durable storage, atomic leases, expiry, backpressure and event cursor recovery still need wiring for restarts and multiple workers.
- Integration tests use simulated host adapters. Real provider sessions, genuine MCP round trips, Windows/Android devices and native app embedding remain release gates.

## Tests
`node --test integrations/backroom/coordination-core.node-test.mjs integrations/backroom/coordination-dispatch-bridge.node-test.mjs`
`node --test integrations/backroom/coordination-dispatch-bridge.integration.node-test.mjs`
`npm run test:backroom`
`npm run test:runtime`
`npm run test:backroom:browser`
`npm run build`

Keep this PR in draft until the full clean-checkout suite and the actual provider/device acceptance criteria pass. Keep production unchanged.
