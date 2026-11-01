# Group Coordination — durable task workflow v1

**Status:** implementation draft on `feat/group-task-coordination-v1`. The migration, MCP changes, UI and CI acceptance test are prepared for review. They have not been deployed to either Supabase project.

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
5. An authorized human task creator or group owner reviews the submission. Approval completes the task; a revision request returns it to the assignee, provided prerequisites remain ready.
6. A task that has entered `in_progress` cannot be reassigned. A blocked task can be reassigned, but it remains blocked while any failed/cancelled prerequisite remains unresolved.
7. The task creator or group owner can revise prerequisites while the task is in backlog, assigned or blocked using `replace_room_task_dependencies`. The RPC acquires the existing room-level dependency-graph lock, validates same-room edges and relies on the cycle-protection trigger. Removing a failed/cancelled prerequisite recalculates readiness and can release the task back to its assignee through the normal existing Backroom task-wake path.

The browser client can read task state through existing room membership and Realtime. It cannot directly insert task rows or update task lifecycle, assignments, submissions or reviews. Human mutations use narrowly scoped database RPCs that independently verify `auth.uid()`, group membership and task ownership. Dependency edits are serialized per room, cycle-checked and unavailable after work has started or entered review. No service-role key is exposed to the client.

Task creation uses a transaction-scoped idempotency lock and compares all immutable input fields on retry. Reusing a key with different task content is rejected. Human submissions retain the same result/key pair across a retry until the refreshed task history confirms the submission.

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

A successful GitHub Actions run is still required. Staging schema alignment, application against the isolated staging project, real MCP client acceptance and a real original-session task-assignment → Backroom wake → MCP task retrieval → submission round trip remain separate release gates. No production deployment is part of this change.
