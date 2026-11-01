# Implementation status

**Snapshot:** 2026-11-01, branch `feat/group-task-coordination-v1`, draft PR #59. This document describes source-level work and release evidence; it does not imply a staging or production release.

## Existing foundation

- Authenticated Rub Minds rooms, human membership, invitations, persistent messages and Realtime updates.
- Hosted MCP sessions for explicit AI participation, private session context and selected shared group memory.
- Backroom browser, desktop, terminal and Android companion paths with scoped identity, permissions and device controls.
- The durable `@RMconnects` wake queue, host pairing and exact-session binding. Wake delivery and MCP contribution are separate states.
- The cloud Device Frame is the default Backroom surface. The browser runtime remains a separate workspace. Android composer targeting now requires a focused-field drag selection and a one-use native token, revalidates the exact node, and clears on focus/content/window changes; physical-device acceptance is still pending, and app inventory, streaming or touch control alone do not verify text targeting.

## Group Coordination slice on the draft branch

The additive task workflow reuses existing rooms, participants, messages, MCP sessions and Backroom wake infrastructure. It includes room-scoped tasks, prerequisites, cycle protection, idempotent creation/submissions, human assignment and review, AI proposals/claims/blockers/submissions through MCP, and task-mode wake jobs using the existing queue and fixed `@RMconnects` prompt. The local continuation adds criterion-level review evidence, fetches only the newest review for each visible task, and prevents stale Realtime refreshes from overwriting newer board state. Approval with acceptance criteria must assess each one as met and retain its evidence note; the PostgreSQL acceptance workflow has been extended but still needs to run on this commit.

The initial task migration and PostgreSQL 17 acceptance workflow passed on the earlier branch head. Remote PR #59 head `b9939a` has passing PostgreSQL wake-queue, Android and Windows companion workflows and a ready Vercel preview. Those checks predate the local review-evidence changes, which still need their own GitHub Actions acceptance run. The feature remains an unmerged draft and has not been applied to staging or production.

## Product boundary

- The authenticated app does not create simulated AI participants. Existing AI sessions join through their own authorized tools and retain their original session identity.
- The browser-local prototype is not mounted by the application entry point and has no simulated-agent action.
- A queued or acknowledged wake does not prove that an AI read the event. An inserted draft does not prove submission. A provider response correlated through MCP is required to demonstrate participation.
- No end-to-end ChatGPT/Claude task assignment → original-session wake → MCP retrieval → deliverable → review round trip has been demonstrated.

## Remaining phases and gates

1. **Close the current branch gates:** production build and browser tests, Windows/desktop companion checks, Android composer-target tests and merged-manifest gate, plus the PostgreSQL task/queue acceptance workflow.
2. **Complete the Group Coordination contracts and engine:** participant operating profiles and evidence-backed capabilities, objective-to-task planning, dependency-aware coordination, turn policies, independent review, conflict handling, stop conditions and auditable completion evidence. Keep human approval boundaries explicit.
3. **Finish original-session integration:** connect the actual selected app/session and verified input target to the group participant, deliver only the authorized fixed wake trigger, capture the MCP contribution, and correlate it to the task/event.
4. **Verify each real surface:** browser, Windows desktop, terminal and Android must pass their own consent, identity, focus, targeting, recovery and revocation checks. Do not infer Android app virtualization from screen streaming.
5. **Stage and release deliberately:** apply schema/functions only to isolated staging after CI passes; complete real-provider and physical-device acceptance before considering production.

## Next engineering focus

After the current PR checks are green, start with the coordination contracts that the human-directed task workflow does not yet provide. Inspect existing participant and connection capability fields first; reuse them where they are authoritative. Add capability-based selection only with provenance, bounded policy and an explicit human approval path. Do not replace the task system, MCP identity, wake queue or device adapters.
