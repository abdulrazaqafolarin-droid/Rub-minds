# Rub Minds — Product Execution Plan

**Last reconciled:** 15 November 2026  
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

**Implemented on the PR #69 development branch, not yet physically accepted:** the Android frame can now be attached to an already-joined MCP participant through an owner-issued one-time challenge tied to the exact MCP session, selected Android package and signing-certificate fingerprint. This is group-collaboration identity, not proof of the provider's exact conversation; that provider identity is a separate native-wake gate. Claude's current documentation now supports one custom remote MCP connector on the Free plan, with an account-configured connector available to Claude mobile clients. Rub Minds has not yet passed a real Claude Free account test. ChatGPT Free is not documented as supporting the write-capable custom MCP workflow needed by Rub Minds. Provider-stable conversation identity and physical device acceptance remain unproven. The provider resolver remains empty, so autonomous native Send is unavailable.

### Desktop

The repository contains a Tauri/Rust desktop companion, Windows/macOS/Linux device-registration/runtime foundations, app inventory, screen/terminal session handling and permission-gated commands.

**Implemented on the PR #69 development branch, not yet physically accepted:** the desktop app and terminal runtimes use the same owner-issued challenge and exact MCP-session binding route. The desktop OS picker proves a whole-monitor capture, not a particular native app window; selected desktop app identity is owner-confirmed context, not window/process attestation. Terminal linkage identifies the live Backroom PTY session, not a separately attested AI process. Full native builds and physical acceptance on each OS remain outstanding.

### Terminal

A Rub Minds MCP stdio bridge exists in the terminal draft branch. It is designed to expose the existing hosted group's invitation, messaging, memory and task tools to an MCP-compatible terminal AI. It does not create a new participant backend or require an always-on local browser host.

**Implemented but not yet accepted:** the MCP tool can bind the exact joined terminal AI session to the active PTY runtime using the shared one-time challenge. The official SDK E2E now covers the binding protocol on a disposable database, but a real OpenCode/Claude Code client and physical desktop terminal acceptance remain outstanding.

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
- Test actual supported clients and their real account/plan/tool permission boundaries. Start with Claude Free's documented one-connector remote MCP path, then verify ChatGPT only on a plan/account that supports the required write-capable custom MCP tools. Record unavailable capabilities honestly; do not treat a generic MCP unit test as provider acceptance.
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

## 6. Current repository checkpoint — 15 November 2026

### Production and release boundary

- Production `main` is `7d63983c336ba1882fff17c8b6b8fa90db3f5632`; production remains separate from the open feature stack.
- No Production database, Edge Function, Auth setting, secret, or Vercel deployment was changed during this audit.
- Keep all release and merge actions behind explicit owner approval. Passing CI or a mergeable PR is not release approval.

### Active implementation stack

- The dependent development sequence is **#52 → #53 → #54 → #55 → #56 → #58 → #59 → #61 → #60 → #62 → #63 → #64 → #65 → #66 → #68 → #69**. These are draft PRs; preserve their base relationships and do not merge out of order.
- PR #69's implementation head before the latest documentation-only corrections was `e062c943eb1503ccc4d29f11121496c8295c9c34`; its base is the PR #68 terminal-MCP branch. The latest PR #69 head now contains documentation-only follow-up commits.
- PR #72, "workspace and Backroom UX", was created from `main` before the full Stage A stack was reconciled. It is explicitly parked as future Stage B exploration. Do not merge it, stack core work on it, or treat it as the active product baseline. After Stage A is accepted, reconcile its useful ideas against the integrated tree and repeat the feature-preservation review.

### Exact-head CI evidence

The implementation commit `e062c943eb1503ccc4d29f11121496c8295c9c34` passed all four current repository workflows:

- [Validate Rub Minds #43717681451](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/43717681451): production build, Vitest, registered Node/runtime/Backroom tests, Deno Edge Function checks, controlled browser tests, clean local Supabase migration rebuild, signup/invitation flows, MCP discovery/SDK tests, and device pairing/revocation.
- [Backroom durable wake queue SQL #43717681460](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/43717681460): wake queue, provider identity, Android settlement/forwarder, task lifecycle/dependencies, criterion review evidence and least-privilege SQL tests.
- [Backroom Android companion #43717681482](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/43717681482): Android unit/protocol tests, manifest gate, compile-verification APK and fingerprint checks.
- [Backroom Windows desktop companion #43717681533](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/43717681533): bundled WebView, Rust tests, authorization tests, Windows release link, fingerprint and artifact upload.

These runs validate the commit's code and disposable/local integration paths. They do **not** establish physical-device acceptance, a real Claude/ChatGPT consumer conversation round trip, or unattended provider-session wake. The later commits on PR #69 update documentation only; their own CI checks must still pass before claiming the latest PR head is green.

### Live MCP deployment distinction

A read-only Supabase audit on 15 November found:

- Production `rub-minds-mcp`: ACTIVE v3, last deployed 25 October. It exposes join/leave, group context/messages, bounded wait, send and session-memory tools. It does not expose the group-task tools, durable original-session bridge-state tools, or `bind_device_frame`.
- Staging `rub-minds-mcp`: ACTIVE v3. It exposes the group tools plus task and original-session bridge-state tools. It does not yet expose the PR #69 `bind_device_frame` tool.
- PR #69 source contains the host-independent frame-binding migration, owner challenge/status/revoke APIs and MCP `bind_device_frame`; this is branch-only until deliberately promoted to Staging and verified there.
- Both deployed MCP functions use the application-level invitation/session authorization path. No OAuth authorization server is implemented. Use only a public Staging publishable/anon key in an `apikey` header if the gateway requires one; never place a Supabase service-role/secret key in Claude, ChatGPT, a browser or a terminal AI client.

### Current provider compatibility

- Anthropic's current documentation (15 November 2026) says Claude Free supports one custom remote MCP connector. A configured account connector can be enabled in individual conversations, including Claude mobile clients. Rub Minds still needs a real Claude Free acceptance run against Staging.
- OpenAI's current Help Center lists custom MCP connections and full MCP support for Business and Enterprise/Edu on ChatGPT web. ChatGPT Free is not listed for the write-capable group workflow. Do not promise direct ChatGPT Free MCP participation; use the guided/manual relay unless the user's account shows a supported capability.
- A remote connector does not itself establish provider conversation identity, transcript access, background execution, or native Send.

### Remaining Stage A acceptance

Real Claude Free connector join/read/write/leave tests, a real terminal MCP-client run, and physical Android/desktop device tests remain outstanding. The Device Frame ↔ AI binding in #69 must be tested against the exact deployed Staging migration/function before it is called available. Provider-specific native Send remains a separate gate; the Android provider resolver is still empty and Windows does not have a native canonical-wake Send driver.

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

Finish Stage A acceptance without changing Production:

1. **Claude Free remote MCP acceptance:** use a disposable Staging group and the Staging MCP URL from `integrations/mcp/README.md`. Configure Claude's single allowed custom connector with only a public Staging `apikey` header if the Supabase gateway requires it. Confirm the real Claude Free client discovers the actual Staging tool catalogue, joins with the intended invite, reads context/messages, sends a harmless group message, preserves private memory, and leaves/revokes. Repeat with Claude mobile after the account connector is configured. Record exact client, plan, tool catalogue and outcomes. Do not use real private conversation history for the test.
2. **Terminal MCP acceptance:** connect a real OpenCode/other MCP-compatible terminal AI client to the documented Staging-only stdio bridge. Verify join, group messaging, task discovery and Leave/revocation with the actual client. The bridge is foreground software, not an always-on worker.
3. **Device Frame acceptance:** after the PR #69 migration and Edge Function are deliberately applied/deployed to Staging, verify the one-time challenge in the exact already-joined AI session and test the Android, desktop and terminal surfaces. Physical tests must establish each surface's actual capabilities; do not infer window/process attestation from whole-monitor capture.
4. Keep native Send/wake disabled where provider conversation identity or device acceptance is absent. A queued wake, detected composer, or cleared input field is not proof that the AI read and answered a group event.
5. Once the same group/AI identity and collaboration path work coherently across phone, desktop and terminal, close Stage A and only then reconcile the full Stage B UI/UX redesign. After that, perform Stage C full product acceptance and Stage D release review.

Do not merge, deploy, mutate Production, or treat the parked PR #72 as complete without explicit owner approval and the relevant evidence.

Only after the association and the shared AI collaboration path work coherently across all three surfaces should the project move to the full UI/UX redesign.
