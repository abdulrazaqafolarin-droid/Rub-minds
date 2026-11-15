# Rub Minds — Product Feature Preservation Matrix

**Stage:** B — full product UI/UX redesign  
**Baseline:** `feat/device-frame-ai-runtime-contract` at `e062c943eb1503ccc4d29f11121496c8295c9c34`  
**Working branch:** `feat/full-product-experience-stage-b`  
**Status:** inventory and design guardrail; no UI implementation is approved by this document alone.

This matrix is the preservation contract for the redesign. It maps the existing product behaviors to their future interface locations, records what is implemented versus experimental, and identifies genuine domain gaps. It exists so that a cleaner interface does not silently remove a capability, collapse two different identities, or advertise a feature that the runtime cannot yet perform.

## 1. Non-negotiable product model

Rub Minds is one collaborative system with one group/collaboration backend. Phone, desktop, terminal and browser are different ways of accessing that system; they are not separate chat products or separate participant databases.

| Object | Canonical meaning | Must not be confused with |
|---|---|---|
| Personal workspace | The signed-in owner's overall Rub Minds environment | A group |
| Group / room | Shared objective, membership, conversation, tasks and group-visible memory | A project, device or AI session |
| Project | A separately defined body of work with its own lifecycle and artifacts | A room task or group objective |
| Participant / mind | An authenticated human or authorized AI identity in a group | A device or application |
| Original AI session | The actual conversation/session that joined through its authorized MCP identity | A new model call or imported history |
| Imported history | User-approved historical context, private by default | A live participant |
| Model / external agent | A separately connected model or independently configured runtime | The user's original ChatGPT/Claude conversation |
| Backroom device | An owner's approved phone or computer | The AI participant |
| Runtime / frame | A live phone app, desktop app or terminal surface | A device login or group member |
| Frame binding | A server-authorized link between an existing group AI session and one exact live frame | Group membership or permission to send |
| Execution adapter | Browser, local host, Android, desktop or terminal mechanism operating a surface | The product identity itself |

**V1 membership rule:** one original AI conversation is assigned to one group at a time. The AI participant is the joined MCP session. The device/frame is attached to that participant; it must never create a duplicate participant. Multi-group membership for one original AI conversation remains deferred.

## 2. Current feature inventory and preservation requirements

Status labels used here:

- **Implemented + exact-head CI:** present in the Stage A source and covered by the successful exact-head workflows listed in Section 5.
- **Source implemented; real-world acceptance pending:** code and automated contract tests exist, but physical device or real client verification is still required.
- **Experimental / bounded:** usable only with stated runtime, consent and lifecycle limits.
- **Not implemented as a product capability:** do not invent UI state, fake progress or imply it exists.

### A. Entry, authentication and workspace access

| Existing behavior | Source of truth | Redesign destination | Preservation rule |
|---|---|---|---|
| App selects Cloud workspace, Backroom or local demo route | `src/main.tsx`, `src/App.tsx`, `src/BackroomApp.tsx` | Global application shell and route map | Keep demo fallback visibly distinct from authenticated cloud data. |
| Supabase sign-in, sign-up, sign-out, password reset and recovery | `src/CloudApp.tsx`, `src/cloudRooms.ts`, `src/supabase.ts` | Account / authentication screens | Preserve session recovery and existing-account sign-in. |
| Invitation token preserved through human sign-up/sign-in | `src/inviteLinks.ts`, `src/cloudRooms.ts`, `src/CloudApp.tsx` | Invitation landing and auth hand-off | Never lose a valid pending invite during authentication. |
| User's existing groups list and group selection | `src/CloudApp.tsx`, `src/cloudRooms.ts` | Home and Groups | Do not replace real group records with sample cards or fabricated stats. |
| Create group with title and objective | `createCloudRoom` in `src/cloudRooms.ts` | Create-group flow | Preserve room objective and ownership behavior. |
| Join by invitation link | `readInviteToken`, `redeemCloudInvite`, `src/CloudApp.tsx` | Join-group flow | Retain malformed, expired, revoked and successful-invite states. |

### B. Group workspace and collaboration

| Existing behavior | Source of truth | Redesign destination | Preservation rule |
|---|---|---|---|
| Room objective / shared purpose | `rooms`, `src/cloudRooms.ts`, `src/CloudApp.tsx` | Persistent group header / overview | Keep visible across work modes. |
| Human and AI participants with distinct kinds | `participants`, `participantKindLabel`, `src/CloudApp.tsx` | People & Minds within the group | Preserve participant kind and connection state. |
| Group messages and Realtime refresh | `messages`, `subscribeToCloudMessages`, `src/cloudRooms.ts` | Conversation | Preserve message ordering, sender attribution, timestamps and refresh lifecycle. |
| Owner invite and access management | `createCloudInvite`, `revokeCloudInvite`, `src/CloudApp.tsx` | Group access / Connections | Preserve owner-only actions, expiry, usage limits and revocation. |
| Separate AI runtime credentials and lifecycle | `connectCloudAgent`, `listAgentConnections`, `revokeCloudAgent` | Group Connections / AI connections | Do not describe a separate agent credential as attachment of the current ChatGPT/Claude conversation. |
| Existing AI guided context relay | `src/aiRelay.ts`, `src/CloudApp.tsx` | Original-session onboarding and Conversation tools | Keep manual relay labelled manual; it is not automatic two-way sync. |
| Private session context import, restore and deletion | `session_memory` functions and `src/cloudRooms.ts` | Private context, visible only to its owner/participant | Raw history remains private by default; preserve explicit import and deletion. |
| Explicit shared group memory | `room_memory_entries`, `saveGroupMemoryEntry`, `deleteGroupMemoryEntry` | Group knowledge / shared memory | Keep explicit visibility and typed entries (goal, insight, decision, open question, progress, summary). |
| Group task board, task dependencies and review evidence | `src/GroupTaskBoard.tsx`, `src/cloudRooms.ts`, task migrations and MCP tools | Tasks / Work inside the group workspace | Preserve all task lifecycle controls, dependency rules, submissions, evidence and human review. Never omit this when redesigning `CloudApp`. |
| Task updates and Realtime refresh-race protection | `GroupTaskBoard.tsx`, `subscribeToGroupTasks` | Tasks activity / task detail | Keep latest-snapshot ordering and idempotent retry behavior. |
| Task-mode wake using the existing queue | Task migration, `backroom-wake`, existing queue RPCs | Task execution status | Queue acknowledgement is not task completion or AI result delivery. |

**Task workflow is not a project system.** Tasks are room-scoped records using the existing collaboration backend. There is not yet a dedicated Project domain/table with independent lifecycle, artifacts and sharing semantics. Do not present room tasks as full Projects.

### C. AI identity, MCP, original-session continuity and privacy

| Existing behavior | Source of truth | Redesign destination | Preservation rule |
|---|---|---|---|
| AI invitation discovery and redemption | `ai-invite-discovery`, `redeem-ai-invite` | AI onboarding | Discovery is not redemption; redemption requires explicit authorization. |
| Hosted MCP group join, read context/messages, send message and leave/revoke | `supabase/functions/rub-minds-mcp/index.ts`, `integrations/mcp` | AI connection details / group tools | Keep one server-owned MCP session/participant identity and bounded tool scopes. |
| Group task MCP actions | MCP task tools in `rub-minds-mcp` | AI task participation | AI can propose, claim assigned work, block/fail and submit; it cannot approve its own work. |
| Private imported session memory | `session-memory`, MCP memory tools | Private session memory | Never auto-share transcript content or hidden provider context with a group. |
| Explicit group-visible memory | `remember_memory` / memory APIs | Shared group knowledge | Require explicit visibility choice; preserve participant-private separation. |
| MCP session handle, credential encryption, expiry, idempotent join and revocation | MCP migrations and `integrations/mcp` | Advanced connection details, mostly hidden from normal users | Bearer handles and credentials never appear in URLs, logs or ordinary UI. |
| Durable original-session bridge cursor and pending response | `integrations/playwright/session-bridge.mjs`, bridge-state migration | Original AI session status / recovery | Retry the same pending body with the same source-message ID; never duplicate an uncertain send. |
| Bounded browser continuation and recovery | `integrations/browser-loop`, `docs/CONVERSATION_RESUME_DESIGN.md` | Optional browser-session helper | Must remain opt-in, attended and bounded; a saved URL is not remote control or a wake mechanism. |
| Local original-session Playwright runner | `scripts/original-session-bridge.mjs`, provider adapters | Optional advanced local connection | Dedicated persistent profile, exact pinned conversation, explicit START and per-message SEND approval. Not an always-on cloud service. |
| Terminal MCP stdio proxy | `integrations/mcp/stdio-proxy.mjs`, `scripts/rub-minds-mcp.mjs` | Terminal client connection | It forwards the existing MCP tool catalog; it does not create another group backend or wake idle consumer sessions. |

**Provider limitation:** CI protocol tests do not prove a real ChatGPT or Claude account can connect. Plan/feature availability and provider permission prompts must be verified per real client. Do not promise full conversation-history access, native app connector support, or two-way sync based only on a URL or an MCP unit test.

### D. Backroom devices, applications and execution surfaces

| Existing behavior | Source of truth | Redesign destination | Preservation rule |
|---|---|---|---|
| Device pairing code creation, expiry, owner approval and revocation | `src/BackroomDevicesApp.tsx`, `src/backroomCloudDevices.ts`, `backroom-device` | Backroom device collection and device detail | Keep one-use pairing and owner approval; keep device credentials private. |
| Phone / desktop / terminal surface selection | `src/BackroomDevicesApp.tsx` | Device interior / app workspace | These surfaces need distinct, appropriate layouts—not one generic mock device. |
| Selected Android app inventory and device events | `backroom-device`, `src/backroomCloudDevices.ts` | Device apps and activity | Inventory does not mean an app is connected to an AI participant. |
| Android screen share, local accessibility inspection, composer targeting and draft insertion | `src/BackroomAndroidControl.tsx`, Android companion | Phone app surface | Preserve local approval, exact target checks, draft-only versus Send distinctions and revoke/stop paths. |
| Desktop app inventory, screen stream, window/control discovery and draft typing | `src/BackroomDesktopControl.tsx`, desktop companion | Desktop device interior | The current picker confirms a whole-monitor stream; selected app context is not native window/process attestation. |
| Native terminal PTY start, project sync, command approval, diff review and local apply | `src/ExternalWorkspacePanel.tsx`, local host workspace API | Terminal interior / execution drawer | Keep explicit local approval and source/patch review; do not silently commit, push or post patches to group memory. |
| Device events and actor attribution | `backroom_device_events`, `listBackroomDeviceEvents` | Backroom / group activity | Preserve actor type (owner, AI, device, system), app association and timestamp. |
| Existing AI-to-frame one-use challenge, exact-session bind, status and revoke | `src/BackroomFrameAIConnector.tsx`, `backroomCloudDevices.ts`, `bind_device_frame` | Device interior → selected AI conversation | Link the already-joined AI session to the frame; do not create a device participant or duplicate group identity. |
| Local host pairing and managed browser runtime | `src/BackroomApp.tsx` (legacy browser path), `scripts/backroom-host-server.mjs`, `integrations/backroom` | Optional browser runtime / advanced local execution | Browser host remains optional; it must not become prerequisite for phone, desktop or terminal collaboration. |
| Browser Off / On / Auto wake modes | `integrations/backroom/interaction-mode.mjs`, wake queue and local host | Advanced browser participation controls | Mode behavior, consent expiry, local host online requirement, rate limit and unconfirmed-off state must be truthful. |

**Backroom product gap:** the current Device Workspace implementation is primarily group-scoped and paired-device oriented. The intended product is a first-class Backroom area where the owner manages their devices and applications, then explicitly associates a particular AI conversation with a group. The redesign must distinguish an owner's device inventory from the device's group pairing. A saved device record is not a provisioned cloud VM, Android emulator or persistent hosted app runtime.

### E. Group coordination and execution safety

The redesign must retain the existing boundaries between:

1. group objective and task planning;
2. participant assignment and task readiness;
3. the durable wake queue and exact event delivery;
4. provider trigger submission;
5. AI response generation;
6. MCP group-message delivery;
7. human review and task completion.

A queued wake, an acknowledged trigger, inserted draft, cleared composer, completed AI response, sent group message and approved task are **different states**. The interface must never collapse them into one green “done” state.

Keep these safety controls discoverable where relevant:
- one-use pairing and challenge expiry;
- owner approval and revocation;
- exact group / participant / MCP-session / runtime / app identity matching;
- explicit, time-limited local wake consent;
- immutable provider-conversation identity where required;
- rate limits, idempotency keys, durable leases and no blind retry after ambiguous effects;
- emergency stop and honest stop-confirmation state;
- server-side authorization and least-privilege RPCs;
- private vs group-visible memory separation.

## 3. Target information architecture — without inventing backend features

| Target area | Existing capabilities to place here | Real gap to design / implement explicitly |
|---|---|---|
| Home | Real group list, create/join actions, last-used group context where available | Useful recent activity is not yet one normalized global feed. Avoid fabricated counts or project progress. |
| Groups | Existing rooms, objective, participants, conversation, task board, memory and connections | Team/community and project-focused group types are not yet separate persisted domain types. |
| Group workspace | Conversation, People, Tasks, Private context, Shared memory, Connections, device/AI associations | A unified adaptive workspace mode (research, learn, plan, build, execute, review) needs a defined state model; do not hide or replace existing group sections. |
| Projects | No dedicated Project entity is confirmed in this baseline | Design a separate project data model and its relationship to groups/tasks before showing project creation, progress or artifact claims. |
| People & Minds | Group participant list, participant kinds, AI connection records | A full global people/minds directory and richer profiles/capability provenance are not established by the current schema. |
| Backroom | Paired phones/computers, app inventory, phone/desktop/terminal frames, AI-frame bindings, activity events | Global owner device inventory, app catalogue/runtime provisioning and cross-group device lifecycle require explicit domain/API design. |
| Activity | Group messages, task history and Backroom device events | A durable cross-product event feed is not yet a single unified queryable experience. Preserve existing histories while designing the aggregation layer. |
| Settings | Existing account/auth controls and theme preference | Do not add pretend device policies, notifications or provider permissions without a working backend contract. |
| Invitations | Human invite, AI credential, guided original-session route, revoke and expiry | Make actual connection method and current client capability obvious; keep manual relay separate from direct MCP. |

The Home and group UI should be redesigned around real records and existing operations. A placeholder is allowed only when it is clearly labelled as unavailable/not implemented, never disguised as live data.

## 4. Required behavior when relocating existing functionality

- Conversation must remain a first-class, persistent group surface—not disappear behind an overview page.
- Tasks must remain accessible from the group workspace and preserve all existing human/AI lifecycle actions and review evidence.
- People must retain human/original-session/model/external-agent distinctions.
- Private context and group-visible memory must remain separate in both navigation and authorization.
- Connections must continue to manage invite creation/revocation, AI join path and separately configured agents.
- Backroom must retain pairing, approval, revocation, real device/app connection, frame association, desktop and terminal controls, and the optional browser runtime.
- Device/frame binding must remain separate from group membership and native Send authorization.
- All important loading, empty, error, expiry, revoked, offline, pending approval and unsupported-client states must remain visible.
- Every new control must call a real existing API or be explicitly labelled as not yet available. No decorative/inert controls.

## 5. Verification baseline

The Stage A stack was tested on exact commit `e062c943eb1503ccc4d29f11121496c8295c9c34`:

- [Validate Rub Minds — full build, runtime, Deno, browser and local Supabase E2E](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/43717681451) — success.
- [Backroom durable wake queue SQL — migrations, queue, Android settlement, task lifecycle and least privilege](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/43717681460) — success.
- [Backroom Android companion — unit tests, merged manifest and compile-verification APK](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/43717681482) — success.
- [Backroom Windows desktop companion — WebView, Rust, protocol tests and release executable](https://github.com/abdulrazaqafolarin-droid/Rub-minds/actions/runs/43717681533) — success.

This proves clean-run source/build/database protocol checks on the branch. It does **not** prove physical handset/workstation behavior, a live OpenCode/Claude Code MCP client, or real authenticated ChatGPT/Claude app compatibility. Those remain full acceptance gates in Stage C. Native autonomous Send remains unavailable where provider conversation identity is not resolved and physically accepted.

## 6. Stage B implementation order

1. Reconcile the Stage A branch with the newer UI/theme work already merged to `main` in PR #70 and the CI fixes in PR #71. Preserve both the newer design system and the Stage A task/device/session features. Do not replace the Stage A branch with `main` or copy a single component over it.
2. Complete the screen/route inventory and agree the navigation shell, group workspace layout and Backroom device hierarchy against this matrix.
3. Implement the shared design system and accessible responsive application shell.
4. Redesign the group workspace while retaining conversation, participants, tasks, private context, shared memory, connections and device links.
5. Redesign Backroom as a first-class owner device/application area while clearly distinguishing owner devices, group pairing, runtime state, frame binding and AI membership.
6. Implement Projects, global People & Minds and unified Activity only after their data/permission contracts are explicit. Do not fake these domains with room/task/device counts.
7. Add responsive/browser acceptance tests covering every preserved route, control, error and status.

## 7. Change control

- This is an inventory and design contract, not authorization to change Supabase, production settings, secrets or deployments.
- Keep the Stage A PR stack and this Stage B branch separate until their changes are reviewed and verified.
- No existing feature may be deleted, silently downgraded or relabelled as complete during visual redesign.
- If an existing capability must change, record the current behavior, reason, migration path, affected tests and replacement before coding.
- Do not merge a new PR or deploy to production without explicit authorization.


## 8. PR #70 reconciliation — design and safety changes

PR #70 merged into `main` after the Stage A stack was created. Its contents are not all present in the Stage A baseline and must be reconciled deliberately.

### Design-system and UI files to bring forward

- `src/UiPreferences.tsx`, `src/themePreference.ts`, `src/themePreference.test.ts`, `src/uiFlow.ts`, `src/uiRedesign.test.ts`
- `src/rub-minds-redesign.css`
- the PR #70 versions of `src/main.tsx`, `src/App.tsx`, `index.html`, and `tsconfig.json`
- `docs/UI_UX_REDESIGN.md` and `scripts/ui-redesign.browser-test.mjs`

The theme uses the same primary blue (#2464EB) in light and dark modes, with the `--rm-*` design tokens. Preserve the preference provider, reduced-motion behavior, accessible dialogs, responsive layouts and browser acceptance. Do not replace the Stage A `BackroomApp.tsx` wrapper with the older, group-scoped legacy browser simulator from main.

### CloudApp reconciliation

Use the PR #70 CloudApp presentation and authenticated invite flows as the visual baseline, then add the Stage A group-task behavior as an additional group workspace tab. Keep the Stage A `cloudRooms.ts` API and task migration/tool contracts. The task board must continue to use `GroupTaskBoard` and its existing backend operations; no new task implementation or table is needed.

Do not copy the entire Stage A CloudApp over the PR #70 design, or copy the PR #70 CloudApp without restoring the task board. Both approaches would discard part of the product.

### Backroom safety reconciliation

PR #70 also changed:
- `integrations/backroom/dispatcher.mjs`
- `integrations/backroom/durable-wake-runtime.mjs`
- their regression tests

Those changes ensure the durable execution seal and one-shot grant are required at the final `beforeEffect` boundary; after that boundary, an ambiguous UI effect becomes `needs_review`, not a retryable preflight failure. This is a safety requirement, not cosmetic UI work. It must be reconciled with the later Stage A device/native/provider changes by applying the specific guard behavior without replacing later Stage A code wholesale.

PR #70's Backroom styling additions were written for the legacy browser workspace. Apply the theme to the Stage A `BackroomDevicesApp` separately. Its current `backroom-cloud.css` contains fixed dark colors; do not assume the global theme automatically covers this screen.

### Known interface/domain boundaries

- The Stage A `BackroomDevicesApp` is still selected-group scoped. It is not yet a global owner-owned virtual device library or provisioned cloud VM.
- Phone, desktop and terminal surfaces have real companion/runtime code in source. Their CI artifacts are not physical device acceptance.
- Android provider-conversation resolver is empty and Windows native canonical Send is not implemented. Native autonomous Send and native Off/On/Auto must remain unavailable.
- Projects, global People & Minds, and unified Activity are not backed by dedicated current domain APIs. Design the future contracts before surfacing these as functioning features.

These additions supersede any assumption that Stage B only needs to port colors and layout.
