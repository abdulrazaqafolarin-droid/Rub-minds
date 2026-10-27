# Rub Minds end-to-end connection contract (development gate)

Status: audit based on repository source, **not** a passing E2E test. No change to production is authorized by this document.

## What MCP already handles (main branch)
- `supabase/functions/rub-minds-mcp/index.ts` exposes MCP tool calls, including `join_group`, `read_group_messages`, `send_group_message`, and session-memory operations.
- `src/cloudRooms.ts` contains Supabase human authentication, group creation, group membership and invite redemption, human message insert, message subscription, private context imports and group memory.
- `src/aiRelay.ts` contains manual-relay prompts with privacy guardrails. Its prompt is explicitly **not** an automatic transport.

MCP transports commands **when a connected AI client calls the tools**. It does not, by itself, guarantee scheduled calls, automatically wake idle conversations, read the model's original private chat history, open browser tabs, or send text into a provider UI.

## What Backroom currently handles (development branch)
- `integrations/backroom/protocol.mjs`: validates capability-scoped action messages, user approval records and results; terminal execution is reserved.
- `integrations/backroom/offline-queue.mjs`: local queue primitives with injected persistence.
- `integrations/backroom/session-manager.mjs`: user-approved session registration, inspection and close; currently advertises **only** `session.inspect`.
- `integrations/backroom/windows-playwright-driver.mjs`: explicitly managed Chromium tabs and explicitly supplied Playwright page handles. Does **not** attach to arbitrary existing browser tabs or native ChatGPT/Claude apps.

There is **no proven production bridge** between the MCP group transport and the Backroom local session driver on this branch. The existing session manager is not yet a multi-provider reply executor.

## End-to-end acceptance test (must pass before announcing continuous collaboration)

1. Sign in as a human, create a group, and verify membership and invite generation.
2. Join two distinct AI connections through actual supported MCP clients, with explicit authorization. Confirm distinct participant IDs and per-session handles.
3. From AI A, send a uniquely identified group message; verify it is visible in the human room and returned by AI B's `read_group_messages`, without duplicated sends on retry.
4. From AI B, reply; verify AI A receives the reply **after another explicit read**. This proves bidirectional MCP messaging, **not** unsolicited wake-up.
5. Import a reviewed context packet and verify it remains private; publish a separate reviewed group-memory entry and verify only that entry is group-visible.
6. Revocation: remove an AI connection and verify it cannot read or send; verify no previously queued send succeeds using revoked credentials.
7. Start a local Backroom managed browser session with human approval. Verify inspect and cleanup; verify attached existing pages are not closed when unregistered.
8. Only after audited read/send provider adapters ship, exercise **read → propose → local approval → send → verify delivery** for each supported web UI. Test logged-out states, redirects, selector changes, stale tabs, duplicate events, cancellations and origin violations.
9. Test interruption and recovery on Windows and Android independently. Do not describe Android support as completed until a real Android local driver and device test exist.
10. Confirm that the browser/Backroom execution path is opt-in; private provider session state, access tokens and raw chat histories never enter group messages or logs by default.

## Implementation order

- **First**, test and harden the existing MCP send/read/revoke/memory path end-to-end without adding a redundant transport.
- **Then**, add an authenticated local Backroom transport and explicit participant-to-session mapping with group ownership checks.
- **Then**, implement provider-specific read/send/confirm adapters with user approval, idempotency and visible failure states, one provider at a time.
- **Finally**, use supported polling/subscription/agent runtime to re-invoke sessions when permitted. An open chat webpage is not evidence of autonomous background processing.

Release gate: report separate states for coded, local unit-tested, integration-tested, real-device tested, merged, and deployed. Do not deploy production from this development plan.
