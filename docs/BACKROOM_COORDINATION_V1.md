# Backroom coordinator — execution contract v1

This experimental milestone establishes the boundary between group events and user-selected session inputs. It is **not** an unattended ChatGPT/Claude integration, an Android app container, or a deployment-ready wake-up engine.

Pipeline: persisted group event → authenticated participation policy → eligible wake plan → durable per-participant queue (not yet wired) → fresh binding/foreground/composer/approval checks → **draft-only** input action → explicit permitted submit layer (not included) → AI MCP fetch and acknowledgment → cursor recovery.

- Never treat the `@RMconnects` prompt as an authentication token.
- Match group, participant, conversation session, target and local foreground identity before dispatch.
- Do not overwrite non-empty user drafts. Do not automatically click Send.
- Never wake an author in response to its own message; suppress duplicate jobs using durable uniqueness.
- Existing browser/terminal adapters stay behind their own authorization and consent checks.
- Future Android/Windows/PTY adapters should implement the same binding and dispatch contract; platform-specific permissions are required.
- Before integration: wire authoritative event source, encrypted durable storage, real MCP identity lookup, revocation, signed approvals, and true provider acceptance tests.

Test: `node --test integrations/backroom/coordination-core.node-test.mjs`

Release gates: clean checkout test suite; provider-authenticated round trip; foreground and stale-target security; offline/retry and cancellation; user-approved send; real Windows/Android acceptance; no cross-group delivery. Keep production unchanged.
