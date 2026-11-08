# Rub Minds — Product Execution Plan

**Last reconciled:** 8 November 2026  
**Status:** Active product direction; all release claims remain evidence-based.

This document is the working source of truth for the order and boundaries of Rub Minds development. It prevents individual backend tasks, device integrations or UI improvements from pulling the project away from the product.

## 1. Product definition

Rub Minds is one shared collaboration system where humans and their existing AI sessions work together as members of the same groups. Backroom supplies authorized phone, desktop and terminal runtimes around that collaboration.

The product is not three separate clients with three group databases. It is one group/collaboration brain reached through different surfaces.

**Canonical identity rule:** the AI session running inside a phone app, desktop app or terminal is the participant. The device/frame is the runtime that participant is attached to; the frame is not another participant.

The intended result is that an existing AI conversation can join a Rub Minds group, retain its own conversation-specific knowledge and working style as far as its platform permits, understand the group's objective and members, and use authorized group messages, tasks and memory. Conversation history is private by default. Importing it requires the session owner's explicit consent; sharing selected memory with the group is a separate explicit choice.

## 2. Canonical system model

- **Human identity:** an authenticated Rub Minds account, with owner/member permissions.
- **Group:** one room with its objective, human and AI participants, messages, tasks, and memory entries explicitly marked for group visibility.
- **AI participant:** the existing joined MCP session and its server-verified participant credential. It is not re-created for each device surface.
- **Device:** an owner-approved phone or computer paired to a group. The device has its own authenticated, revocable credential.
- **Runtime/frame:** the exact live app or terminal session on that device. It is a scoped execution surface, not a group identity.
- **AI-to-frame association:** a server-owned, expiring association between the existing joined AI session and the selected live frame. It must be host-independent for the core product.
- **Backroom execution:** screen, app, terminal and input operations that are separately permissioned. Group membership alone never grants app-control or Send permission.
- **Browser runtime/local host:** optional execution support. It must not be a prerequisite for phone, desktop or terminal group participation.

There is one source of truth for membership, messages, memory, tasks and permissions. Do not introduce a second group/message/task backend for devices or terminal clients.

## 3. Product surfaces and the verified starting point

### Phone

The repository contains an Android companion app and Android-side policy/tests. It supports device pairing, selected-app inventory, device credentials, screen-sharing setup, Accessibility-based local target inspection and permission-gated control paths.

**Not yet proven:** a completed host-independent association between an already-joined AI MCP session and an exact phone app frame; real ChatGPT/Claude consumer-app joining through supported client tooling; provider-stable conversation identity; physical device acceptance for the full flow. The provider resolver is documented as empty in the current provider-identity draft, so autonomous native Send must remain unavailable until it is implemented and physically verified.

### Desktop

The repository contains a Tauri/Rust desktop companion, Windows/macOS/Linux device-registration/runtime foundations, app inventory, screen/terminal session handling and permission-gated commands.

**Not yet proven:** full native builds and physical acceptance on each target operating system. The host-independent AI-session/frame backend is in the PR #69 development branch, but the desktop OS picker currently proves a whole-monitor capture rather than a particular native app window; selected desktop app identity is owner-confirmed context, not window/process attestation.

### Terminal

A Rub Minds MCP stdio bridge exists in the terminal draft branch. It is designed to expose the existing hosted group's invitation, messaging, memory and task tools to an MCP-compatible terminal AI. It does not create a new participant backend or require an always-on local browser host.

**Not yet proven:** clean runner execution and a real terminal AI-client acceptance test against the intended staging service.

### Group collaboration and AI access

The source includes the cloud group experience, human sign-in and invitations, hosted MCP joining, group messaging, private session-memory import, explicit shared memory, and group task coordination.

A source implementation or an MCP tool definition does not prove that a specific free ChatGPT/Claude app or terminal agent can actually connect and complete the flow. Each supported client must be verified using the real client and its real permission model. Do not promise provider-history access or two-way synchronization beyond the data and actions that the client actually exposes.

### Browser

The browser runtime remains an optional surface. A local host may help with browser-specific execution, but the core phone, desktop and terminal participant flow must work without depending on it.

## 4. Agreed development order

This order is deliberate. It avoids polishing an interface around incomplete capabilities and avoids turning the optional host into a product prerequisite.

### Stage A — Finish the core product across phone, desktop and terminal

This is the current priority. Complete the core capabilities across the three first-class surfaces, with the shared collaboration system built into each one.

1. **Stabilize the shared group/AI identity contract.** An AI joins once through its existing MCP session. Device and frame identities attach to that participant; they do not generate duplicate AI participants or group data.
2. **Complete host-independent device-frame association.** The owner selects a live phone, desktop or terminal frame and issues a short-lived, one-use challenge. The exact AI MCP session already joined to that group completes the challenge. The server checks group, participant, MCP session, owner, approved device, device-room pairing, live runtime, selected app/process identity, expiry and replay safety. This route must not depend on `backroom_hosts` or `backroom_input_bindings`.
3. **Connect group collaboration on every surface.** The attached AI uses the same authorized group tools for context, messages, tasks and memory. Message delivery, retry/idempotency, session revocation and privacy rules remain server-owned.
4. **Finish the phone path.** Pair/approve the phone, select the actual app, bind the already-joined AI session to that app frame, expose the truthful capabilities, and verify the supported group collaboration path. Native Send/wake remains an additional gate, not a dependency for ordinary group participation.
5. **Finish the desktop path.** Register the computer, discover/select its real app or terminal runtime, attach the actual AI session, and use the same group collaboration backend. Validate the real Tauri companion on supported OS targets.
6. **Finish the terminal path.** Expose the same group tools to a real MCP-compatible terminal AI client. The active terminal AI session itself is the participant; the CLI bridge is transport, not a separate agent identity.
7. **Unify permissions and capability reporting.** Clearly distinguish joined, paired, runtime-live, frame-bound, draft/manual capability, provider-attested, and native-wake-ready. Never infer a stronger capability from a weaker one.

Do not split shared collaboration into a separate side project or build duplicate group systems. It is part of the phone, desktop and terminal foundations.

**Ongoing engineering checks:** run focused unit, protocol, authorization and migration regressions with each vertical slice. These are continuous guardrails, not the final product acceptance phase.

### Stage B — Redesign the whole Rub Minds UI/UX

Start this after the core phone, desktop and terminal capabilities have a coherent and verified implementation contract. This is a full product interface redesign, not a cosmetic pass over the current screens.

First audit and map all existing screens and routes: the cloud group experience, invite/sign-in flow, Backroom device workspaces, desktop/terminal panels, existing browser runtime and older demo fallback. Then define one consistent product information architecture and visual system.

The redesigned experience must cover:

1. **Home and groups:** clear group list, create/join flows, recent work and group status.
2. **Group workspace:** objective, human/AI participants, conversation, activity, tasks and group-visible memory in one understandable space.
3. **Invitation and AI onboarding:** preserve invitation through human sign-in; explain the AI/MCP connection route; show whether the actual client is connected instead of pretending a participant has joined.
4. **Backroom/device workspace:** phone, desktop and terminal surfaces under one coherent navigation model; device approval, selected app/runtime, live connection, frame association, permissions and truthful capability states.
5. **AI and member management:** identity, connection state, access, revocation and private-versus-shared memory controls.
6. **Responsive behavior:** deliberate phone, tablet and desktop layouts, not a desktop page squeezed onto a phone.
7. **Interaction quality:** accessible controls, keyboard support, clear loading/empty/error/retry states, confirmation for consequential actions, and no simulated AI activity represented as real activity.

The interface should make the product's central idea obvious: people and the AI sessions running in their actual apps/devices collaborate in the same Rub Minds group.

### Stage C — Full product testing after the UI/UX redesign

Run the complete acceptance programme after the new interface is integrated, while retaining focused regression checks during Stage A and B.

- Rebuild the complete Supabase schema locally from all migrations; test constraints, RLS, grants, service-role-only RPCs, lifecycle triggers and rollback assumptions.
- Run the full Node test suites, TypeScript/Vite build, Deno function checks, Android Gradle/JUnit build and desktop native builds on clean runners.
- Verify human signup/sign-in, invite preservation after sign-in, create/join group and multi-user message synchronization.
- Use real supported MCP clients to join as independent AI sessions, exchange group messages, read group context, coordinate tasks, import private session context with consent, share only explicitly group-visible memory, and leave/revoke.
- Test the same group through phone, desktop and terminal without a browser host. Verify the exact AI participant identity remains the same when it is attached to a frame.
- Test actual supported ChatGPT and Claude clients and their real account/plan/tool permission boundaries. Record unavailable capabilities honestly; do not treat a generic MCP unit test as provider acceptance.
- Physically test Android and each supported desktop OS. Test terminal clients with a real running terminal AI.
- Test network loss/reconnect, expiry, replay, duplicate requests, concurrent joins/sends, revocation, stale device/runtime and recovery.
- Run UI acceptance at narrow phone widths, tablet and desktop sizes, including accessible navigation and all important error/empty/loading states.
- Verify privacy boundaries: private transcript imports, group-visible memory, device credentials, provider identifiers and bearer handles.

### Stage D — Security, reliability and controlled release

After Stage C, perform the final security and operational review, performance and resource checks, recovery/backup review, cost check and staging acceptance. Only then prepare a production release. **No production migration, secret change, Edge Function deployment, merge or production deployment is implied by this plan; production changes require the user's explicit authorization.**

## 5. Native Send and autonomous wake are separate advanced capabilities

Provider identity and native wake are valuable, but they must not block basic cross-surface group collaboration. A selected app being visible, an app being installed, a composer being detected or an MCP participant being joined does not prove that autonomous Send is safe.

Native Send/wake requires a verified exact provider conversation identity, an approved app/device, a live frame, explicit time-limited consent, replay-safe delivery/settlement and physical acceptance. Until all of those gates pass, the UI must show the capability as unavailable or draft/manual only.

Do not weaken the legacy host-scoped wake queue to make the hostless group-binding path appear complete. Keep the old queue intact; introduce and validate a separate host-independent frame-association path.

## 6. Current repository checkpoint — 8 November 2026

- Private repository: `abdulrazaqafolarin-droid/Rub-minds`.
- Production is separate from the current development branches. Do not deploy or mutate production during this work.
- PR **#66** (provider-conversation identity/native wake) is open and draft.
- PR **#68** (terminal MCP bridge) is open and draft; its base is PR #66's branch.
- PR **#69** (Device Frame AI session classification contract) is open and draft; its base is PR #68's branch.
- The current dependency stack is therefore **#66 → #68 → #69**. Review dependency and changed-file scope before changing that relationship; do not merge out of order.
- The latest observed PR #69 Actions run (run `42473274802`) completed with failed jobs whose `steps` values were null and whose logs were unavailable. This is **not a CI pass** and does not identify a source-level test failure.
- PR #69 describes a focused 12/12 policy test run in an isolated Node harness. That is not a complete repository test/build, a Supabase migration replay or real device/provider acceptance.
- PR #68's own description states that its tests have not executed on a runner and that no real terminal AI client has been connected.
- PR #66's description records the provider resolver/physical provider acceptance and full CI/database/native-build gaps. Its native-wake work is not deployed or physically accepted.
- The host-independent device-frame binding schema, owner challenge/status/revoke routes and `bind_device_frame` MCP tool are committed on the PR #69 development branch. Challenges now target the exact MCP session digest as well as the participant. Transactional SQL functional tests and an official MCP SDK test for wrong-session rejection, successful bind, idempotent replay and Leave revocation are being wired; they have not yet executed on a clean runner. Real phone/desktop/terminal acceptance remains outstanding.

## 7. Rules for keeping the work on course

1. Keep the product definition and sequence in this document as the decision reference. If a task conflicts with it, stop and reconcile the task before coding.
2. Work in small, complete vertical slices. State the goal, contract, files, authorization boundary and tests before changing code.
3. Preserve one collaboration backend and one AI participant identity. Do not invent a second room, participant, memory, message or task system for a device surface.
4. Treat phone, desktop and terminal as first-class product surfaces; treat browser host as optional.
5. Do not pull the full UI redesign forward ahead of the core capabilities. Do not postpone focused regression checks until the final test phase.
6. Keep PR dependencies explicit. Verify current branch/commit/check state before each write; distinguish code added, committed, test-run, merged and deployed.
7. Never call source inspection a test pass. Never call a synthetic/mock test physical acceptance. Never call a draft/unmerged PR delivered.
8. Keep private source and secrets in the private repository. Use isolated/free validation resources where possible; do not spend Actions or deployment quotas casually.
9. Do not modify production, merge a new PR or deploy without the relevant explicit authorization.
10. Report progress against the stages above, including what is complete, what is blocked, the evidence, and the single next task.

## 8. Immediate next task

Continue Stage A by completing the **host-independent AI-session-to-device-frame association** already committed in PR #69. Execute the local Supabase migration reset, expanded SQL functional test and official MCP SDK bind/replay/Leave-revocation test; correct any migration/trigger failures. Then add local Backroom Edge Function owner challenge/status/revoke coverage and verify the same selected AI participant across Android, desktop app context and terminal PTY. Keep native Send/wake out of scope for this slice. Follow with the same association for terminal frames and desktop/phone app frames as the shared contract permits.

Only after the association and the shared AI collaboration path work coherently across all three surfaces should the project move to the full UI/UX redesign.
