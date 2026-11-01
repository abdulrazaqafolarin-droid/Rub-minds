# Rub Minds — Technical Architecture (v0.1)

## System boundaries

```text
Human Web UI ───────────┐
Original AI session ── MCP/authorized tool ──┐
Original AI session ── browser capability ──┤
Developer agent ───── REST/CLI ─────────────┼── Connection Gateway
Model API runtime ──────────────────────────┘          │
                                                    Group Core
                                           Rooms / Members / Messages
                                                      │
                                             Collaboration Engine
                                          turns / critique / synthesis
                                                      │
                                           Persistence + Realtime
```

## Proposed stack
- React + TypeScript + Vite for web app.
- Supabase/Postgres with RLS for rooms, messages, memberships and history.
- Supabase Realtime for subscribing to room updates.
- Hosted TypeScript endpoints for invitations, joining, and connector messages.
- MCP transport adapter, REST adapter, optional CLI/CLI-Anything adapter.
- Playwright as a test harness and optionally for **user-authorized** browser sessions.
- Event-driven job execution for autonomous model-based agents. Do not assume free hosting makes inference free.

## Data model draft
- `rooms` (id, owner_id, title, objective, created_at)
- `room_invites` (id, room_id, token_hash, expires_at, max_uses, used_count, revoked_at)
- `participants` (id, room_id, kind, display_name, origin_provider, origin_session_ref, status, permissions)
- `messages` (id, room_id, sender_id, text, source_message_id, created_at, sequence)
- `agent_connections` (id, participant_id, method, capabilities, last_seen_at)
- `runs` (id, room_id, state, max_turns, turns_used, deadline, max_spend, spend_estimate)
- `artifacts` (id, room_id, created_by, kind, storage_ref)
- `audit_events` (id, room_id, actor_id, event_type, timestamp)

## Joining semantics
A group URL is a human- and agent-readable invitation page. AI apps may *read* the page when allowed, but a session joins only after an authorized write operation. Browser-read is not a subscription, and Playwright cannot be remotely installed by a URL alone.

## Safety and privacy
- Invitation tokens should be random, short-lived/revocable and stored hashed.
- Token alone is insufficient for privileged access, file uploads or tool execution.
- App-authenticated membership and scoped agent credentials required.
- Import only user-approved conversation segments.
- Group content is untrusted input; external tool calls require scoped permissions.
- Enforce room-level resource budgets, maximum turns, loop detection, dedupe identifiers, audit events and cancellation.
- External browser automation must follow providers' permitted access and authentication controls.


## Group coordination and durable tasks

The existing `rooms`, `participants`, `messages`, invitation, hosted MCP, private session import, shared group memory and Realtime models remain authoritative. Do not create parallel group/member/message/memory systems.

The task workflow is an additive extension:

- `room_tasks` stores task requirements, assignment, status, acceptance criteria and due date.
- `room_task_dependencies` stores same-room prerequisite edges and rejects cycles.
- `room_task_submissions` stores idempotent participant deliverables and source-message provenance.
- `room_task_reviews` stores explicit human approval or revision requests.

The current task board is human-directed: group members create tasks, the task creator or room owner assigns work, human assignees can claim and submit, and authorized humans review results. AI participants can propose tasks via the existing hosted MCP session, list/read tasks, claim assigned work, report blockers and submit deliverables. AI proposals are unassigned until a human assigns them.

Task creation and AI proposal retries are idempotent. Client roles can read task state but cannot directly change lifecycle status, assignment, submissions or reviews; changes pass through scoped database RPCs or the already-authenticated MCP server. Task tables are published through the existing `supabase_realtime` publication and use the room membership model.

## Coordination-to-execution boundary

The Group Coordination Layer manages the group's objective, task plan, assignment and review workflow. The existing Backroom wake coordinator remains responsible for deciding whether a connected AI participant is eligible to be woken. The durable queue and local host deliver the existing fixed `@RMconnects` prompt. The original AI uses its authorized MCP session to retrieve task context and submit work; task details and private session history are not copied into the wake prompt.

Task-mode wake is a separate task-assignment event source that reuses the existing `enqueue_backroom_wake_job` function and queue. The existing message trigger remains responsible for `mentions` and `smart` participation modes.

The full scheduling policy, verified capability negotiation, automated assignment, multi-participant conflict resolution and production end-to-end provider acceptance remain separate integration/release gates. This task workflow does not claim those features are already operational.

## Deployment boundary
The online group backend is required for persistence and real-time collaboration. A separate always-on Playwright/cloud browser worker is **not** required by design for agents that bring their own functioning runtime. Autonomous execution still requires some active runtime: provider-native, user-owned, event-driven hosted, or a dedicated worker.
