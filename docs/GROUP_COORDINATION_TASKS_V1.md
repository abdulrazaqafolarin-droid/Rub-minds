# Group Coordination — durable task workflow v1

**Status (2026-11-01):** draft PR #59 on `feat/group-task-coordination-v1`, exact head `8c2b61252d3a4f73b41fa4cc8f92ad52fee98cb2`. The four exact-head GitHub Actions workflows pass, and the additive schema plus related staging Edge Functions are present on the separate Rub Minds Staging project. This has **not** been merged to `main` or deployed to production. Keep the PR in draft until physical-device and live-provider acceptance gates below are complete.

## Integration principle

This workflow extends the existing Rub Minds group model. It reuses:

- `rooms` for group identity and the existing objective;
- `participants` for human and AI participant identities;
- `messages` for group conversation and source-message references;
- existing `room_memory_entries` for shared goals, decisions, progress and summaries;
- hosted MCP sessions and `agent_connections` for AI authorization;
- Supabase Realtime for group updates;
- Backroom input bindings, wake grants, durable queue, host poller, execution journal and canonical `@RMconnects` prompt.

It does **not** create a second group, membership, message, memory, MCP-credential, host or wake-queue system.

## Task records and lifecycle

The additive migration creates four room-scoped records:

- `room_tasks`: task requirements, acceptance criteria, assignment, priority, due date, status and version.
- `room_task_dependencies`: directed prerequisite edges within the same group; cycles are rejected.
- `room_task_submissions`: participant deliverables, bounded source-message provenance and idempotency.
- `room_task_reviews`: human approval or revision requests tied to an exact submission.

Task states are `backlog`, `assigned`, `in_progress`, `blocked`, `review`, `completed`, `failed` and `cancelled`.

A task may have up to 20 prerequisites and up to 20 acceptance criteria. Each criterion is 1–500 characters. Results are bounded to 20,000 characters and may reference up to 50 messages from the same group. Priority is 1 (highest) to 5 (lowest).

A task with incomplete prerequisites remains in backlog and cannot be claimed. Completing a prerequisite releases downstream work when all prerequisites are complete. A failed or cancelled prerequisite blocks dependent work. A dependency edge cannot cross room boundaries or create a cycle; graph edits are serialized per room.

## Human workflow and governance

1. A signed-in human group participant creates a task with a stable idempotency key.
2. The database verifies creator membership, same-room assignees and prerequisites, and the acceptance criteria before inserting the task and its dependency edges atomically.
3. The task creator or group owner assigns work. AI proposals remain unassigned until a human assigns them.
4. A human assignee claims the task and submits a deliverable. A human can also cancel an active task.
5. An authorized human task creator or group owner reviews the submission against every acceptance criterion. Each criterion receives an explicit met/not-met decision and a bounded evidence note; approval is rejected unless every criterion is met and evidenced. The database stores this evidence with the exact submission review. A revision request returns the task to the assignee, provided prerequisites remain ready.
6. A task that has entered `in_progress` cannot be reassigned. A blocked task can be reassigned, but it remains blocked while any failed/cancelled prerequisite remains unresolved.
7. The task creator or group owner can revise prerequisites while the task is in backlog, assigned or blocked using `replace_room_task_dependencies`. The RPC acquires the existing room-level dependency-graph lock, validates same-room edges and relies on the cycle-protection trigger. Removing a failed/cancelled prerequisite recalculates readiness and can release the task back to its assignee through the normal existing Backroom task-wake path.

The browser client can read task state through existing room membership and Realtime. It cannot directly insert task rows or update task lifecycle, assignments, submissions or reviews. The human review RPC requires an ordered evidence object for every task acceptance criterion, rejects incomplete/mismatched evidence and blocks approval while any criterion is unmet; the old four-argument review RPC is removed. Review evidence is visible in task history. Realtime board refreshes use a monotonically increasing request generation so an older network response cannot overwrite a newer snapshot or error state. The evidence JSON payload is capped at 64 KiB in total, with each evidence note capped at 2,000 characters. Existing historical review rows are preserved with an empty evidence array; the mandatory criterion-evidence contract applies to reviews created after this forward migration. Human mutations use narrowly scoped database RPCs that independently verify `auth.uid()`, group membership and task ownership. Dependency edits are serialized per room, cycle-checked and unavailable after work has started or entered review. No service-role key is exposed to the client.

Task creation uses a transaction-scoped idempotency lock. The immutable task requirements and prerequisite set are fingerprinted; the original requested assignee is stored separately from the live assignee. Reusing a key with different requirements or a different original assignee is rejected, while a retry after a legitimate reassignment returns the original task without reverting the current assignee. Human submissions retain the same result/key pair across a retry until the refreshed task history confirms the submission.

## AI participant workflow through existing MCP

The hosted `rub-minds-mcp` surface adds:

- `propose_group_task`: create an unassigned backlog proposal with a UUID idempotency key;
- `list_group_tasks` and `read_group_task`: read bounded task state, prerequisites, submissions and reviews;
- `claim_group_task`: claim work already assigned to this participant, only when prerequisites are complete;
- `block_group_task`: report a recoverable blocker;
- `fail_group_task`: report terminal inability to complete an active task;
- `submit_group_task_result`: submit an idempotent deliverable and move the task to review.

The MCP Edge Function first validates its existing opaque MCP session and live participant credential. Each database operation is scoped to the session's room and participant. AI writes use service-role-only database functions; no service-role credential is given to the MCP client. An AI can propose, claim, block, fail or submit work, but cannot approve its own work or mark a task completed. A human reviewer is required.

Task results are explicit deliverables. Private imported conversation history is not copied into tasks or group memory. Source message IDs are validated against the same room.

## Group Coordination ↔ Backroom wake boundary

The Group Coordination Layer decides the group's work plan, task assignment, readiness and review state. The existing Backroom wake coordinator and durable queue remain the execution-notification infrastructure.

Task assignment is a separate task event source because the existing message trigger intentionally handles only `mentions` and `smart` participation modes. A task enters the existing queue only when its assigned AI participant has:

- a live participant record in the same room;
- a non-revoked, unexpired agent connection;
- a live hosted MCP session bound to that participant;
- an exact existing Backroom input binding;
- `participation_mode='task'`;
- explicit, confirmed and unexpired wake consent.

The task event trigger uses the existing `enqueue_backroom_wake_job` function and fixed canonical `@RMconnects` prompt. The task ID/version is the event cursor; task descriptions, deliverables and group-message bodies are never copied into the prompt. The original AI retrieves task context through its authorized MCP session.

When a task is reassigned, changed, blocked, submitted, failed or cancelled, pending/leased wakes for the previous task version and assignee are cancelled with the existing `cancel_backroom_wake_job` RPC. A successful transition from `assigned` to `in_progress` is treated as the participant's claim/acknowledgement signal and does not cancel the wake that caused it while the host may still be acknowledging delivery. Host queue acknowledgement remains distinct from an AI's MCP response and from human task approval.

## Current feature boundary

This is the first durable task-coordination slice, not the entirety of the Group Coordination Layer. Assignment is currently human-directed; the slice does not yet implement a verified expertise/capability registry, automatic skill-based assignment, multi-agent negotiation, automated conflict resolution, or an autonomous objective planner. Shared goals, decisions, progress and summaries continue to use existing room objective and shared-memory infrastructure.

## Validation and release gates

The branch includes:
- MCP schema/argument tests for task tools;
- cross-layer source regression tests for authorization, RLS, wake reuse and UI wiring;
- a PostgreSQL 17 acceptance test for idempotency, human submission/review, dependency release and failure, AI task-mode wake, reassignment/cancellation and least privilege;
- an extension to the existing Backroom durable-queue CI workflow so the task migration and acceptance test run after the existing queue migration/test.

### Verified checkpoint — 2026-11-01

At exact head `8c2b61252d3a4f73b41fa4cc8f92ad52fee98cb2`, all four GitHub Actions workflows completed successfully:
- [Validate Rub Minds #41332605021](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/41332605021) — full build/runtime suite, browser checks, local Supabase rebuild, invitation and MCP SDK interoperability, session revocation, Vault and migration checks.
- [Backroom durable wake queue SQL #41332605054](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/41332605054) — PostgreSQL 17 queue and group-task lifecycle/dependency/wake acceptance.
- [Backroom Android companion #41332605224](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/41332605224) — Android unit tests, merged-manifest gate and APK build.
- [Backroom Windows desktop companion #41332605015](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/41332605015) — web tests/build, WebView bundle, Rust unit tests, protocol/authorization tests and Windows native compilation.

The separate Rub Minds Staging project has the task and supporting Backroom migrations. Staging `rub-minds-mcp` is ACTIVE v2 and advertises 18 tools, including the seven task operations; `backroom-device` is ACTIVE v13. The checked-in `supabase/tests/group_task_coordination.sql` was executed inside an explicit transaction followed by ROLLBACK; a follow-up query confirmed zero fixture users, rooms, participants, task rows or wake jobs remained. The Vault encryption-key security test also passed inside its own transaction and rollback. Staging table/RPC privilege checks confirmed RLS and least-privilege boundaries for task and service-only device/session/queue data.

### Remaining release gates

- Run the real task-assignment → Backroom wake → original ChatGPT/Claude session MCP retrieval → result submission round trip against an isolated test group. CI and staging source/schema checks do not prove a real provider completed that journey.
- Perform physical Windows 10 companion/ConPTY acceptance and Android handset acceptance (MediaProjection, foreground lifecycle, local touch arming, IME path, revocation and Emergency Stop).
- Reconcile staging migration-history version identifiers with repository migration filenames before any formal promotion.
- Review the remaining staging advisor findings, especially disabled leaked-password protection and the project's authenticated-callable SECURITY DEFINER functions. The task/device privilege checks passed, but the project-wide advisor report is not clean.

No production migration, Edge Function deployment, secret, Auth setting or Vercel production deployment was changed during this checkpoint. PR #59 remains draft and unmerged.
