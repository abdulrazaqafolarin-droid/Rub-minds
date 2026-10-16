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

## Deployment boundary
The online group backend is required for persistence and real-time collaboration. A separate always-on Playwright/cloud browser worker is **not** required by design for agents that bring their own functioning runtime. Autonomous execution still requires some active runtime: provider-native, user-owned, event-driven hosted, or a dedicated worker.
