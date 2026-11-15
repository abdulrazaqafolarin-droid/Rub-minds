# Rub Minds — Product Experience Blueprint (v0.1)

**Status:** Agreed product direction; implementation blueprint  
**Decision date:** 2026-11-15  
**Scope:** Workspace information architecture, groups, projects, adaptive collaboration, participant identity, and Backroom's place in the product.

This document translates the product discovery decisions into an interface and domain blueprint. It is a target design, not a claim that all described capabilities already exist.

## 1. Product promise

Rub Minds is a shared environment in which humans, original AI conversations, connected models, and independent agents can work together. It should feel like a living collaborative workspace—not merely a group chat with bots.

The product should help participants think together, build together, retain useful knowledge, coordinate contributions, and turn collaboration into outcomes.

**Product principle:** one connected ecosystem, multiple working environments, and a clear identity for every human, AI session, project, group, device, and connection.

## 2. Agreed product decisions

1. **Collaborative environment first.** Users enter Rub Minds to discover and work inside groups containing humans and AI participants.
2. **Adaptive group workspace.** A group interface responds to its current activity—brainstorming, research, learning, planning, building, execution, or review—without losing the group's persistent identity, history, participants, or knowledge.
3. **Two group forms.**
   - A **team/community group** is an ongoing team that can work across several projects and discussions.
   - A **project-focused group** is a collaboration group created around one principal objective.
4. **Projects can be organised in more than one way.** A project can be worked on inside a team group, associated with a project-focused group, or remain independent until shared. Relationships and sharing must be explicit.
5. **Backroom is a first-class product area.** It is a personal virtual-device environment containing usable AI applications, not simply a local-host settings page or a browser automation dashboard.
6. **Backroom supports two persistence goals.** Virtual devices and application sessions should be recoverable after the user leaves; background participation should be possible when the selected application/runtime and provider genuinely support it.
7. **V1 AI-session membership is one-group-at-a-time.** Each original AI conversation connected through Backroom is dedicated to one Rub Minds group. Multi-group participation can be considered after the single-group lifecycle, permissions, memory boundaries, and reliability are established.
8. **Truthful capability states.** A saved device is not necessarily running; an open app is not necessarily connected; a connected session is not necessarily autonomous; a historical import is not a live AI participant.
9. **Production safety.** Product planning and prototype work should not silently change production infrastructure. Schema changes must be developed and verified in staging before production rollout.

## 3. Core product concepts

These concepts must remain distinct in the user experience and in the domain model.

| Concept | Meaning |
|---|---|
| Personal workspace | The signed-in user's overall Rub Minds environment. |
| Group | A collaboration container with a purpose, membership, conversation, coordination, and shared knowledge. |
| Project | A defined body of work with goals, tasks, artifacts, decisions, and progress. |
| Participant / mind | A human or AI identity contributing to a group. |
| Original AI session | A particular conversation in an AI provider's application; not interchangeable with a new model call. |
| Imported history | User-approved historical context; it is not a live participant. |
| Model participant | A direct model/API connection; it is not an original provider conversation. |
| Independent agent | A separately configured agent runtime with scoped group access. |
| Backroom device | A virtual phone, laptop, desktop, or browser environment owned by the user's workspace. |
| Application instance | A configured application installed/launched in a particular Backroom device. |
| AI session connection | The authorised link between one original AI conversation and one Rub Minds group in V1. |
| Execution adapter | The underlying local, hosted, browser, mobile, or desktop runtime that makes an application usable. It is an implementation detail, not the primary product concept. |

### Relationship rules for V1

- A workspace owns its Backroom devices and application instances.
- A group owns its membership, messages, group coordination settings, and group-shared knowledge.
- A group may have multiple projects.
- A project may be independent or associated with one or more groups through explicit sharing.
- Sharing a project with a group must not silently expose unrelated private workspace data.
- An original AI conversation connection is assigned to one group only in V1.
- Multiple distinct AI conversations—even from the same provider and same application instance—may be separate participants, subject to provider/runtime capabilities.
- A single group may contain multiple original AI sessions, model participants, independent agents, and humans.
- Private session context is not automatically promoted into group memory.
- Multi-group AI-session membership is explicitly deferred until V1 proves reliable.

## 4. Global information architecture

The primary navigation should be stable across Rub Minds.

1. **Home** — personal overview of current work, groups, activity, connected minds, and attention needed.
2. **Groups** — discover, create, join, and manage team/community and project-focused groups.
3. **Projects** — browse all projects the user owns or has been granted access to, regardless of which group they are associated with.
4. **People & Minds** — discover workspace participants and inspect their identity and connection type.
5. **Backroom** — manage virtual devices, applications, and AI-session connections.
6. **Activity** — review contributions, group events, project progress, connection changes, and approval requests.
7. **Settings** — account, privacy, personal context, appearance, and workspace preferences.

On desktop, use a persistent global navigation rail/sidebar and a central work area. Contextual navigation should appear within the active group, project, or device. On smaller screens, global navigation may collapse into a compact drawer or bottom navigation, while preserving the same concepts and routes.

The global shell should make it easy to move between a group and Backroom without losing the selected group/project context.

## 5. Home: personal collaborative overview

Home is not just a list of rooms or a chat inbox. It should help answer:

- What am I working on?
- Which groups are active?
- Which projects have moved forward?
- Which humans and AI sessions are currently connected or need attention?
- What decisions, messages, tasks, or approvals need me?

Recommended sections:

- **Continue working:** recently opened groups and projects.
- **Your groups:** compact overview of team and project-focused groups.
- **Projects in progress:** projects with status, next milestone, and associated group.
- **Minds and connections:** clear live/waiting/paused/disconnected indicators.
- **Recent activity:** meaningful contributions, decisions, completed work, and requests.
- **Needs your attention:** approvals, failed connections, unresolved questions, and blocked work.
- **Quick actions:** create group, create project, join by invitation, open Backroom, add an AI application.

Avoid overwhelming Home with every message or every low-level runtime event. Prioritise useful changes and items requiring attention.

## 6. Group experience

Every group shares a persistent collaboration shell, regardless of its current activity.

### Stable group identity

- Name, purpose/objective, group form, owner, and membership.
- Group-wide activity and recent outcomes.
- Participants and each participant's actual connection state.
- Projects associated with the group.
- Shared conversation/history.
- Group knowledge and memory.
- Participation policies, permissions, invitations, and controls.

### Proposed group areas

These are conceptual work areas, not necessarily permanent top-level tabs:

- **Overview** — purpose, current focus, progress, and important updates.
- **Workspace** — adaptive central canvas for the current activity.
- **Conversation** — shared communication between humans and connected AI participants.
- **Projects & Work** — tasks, milestones, deliverables, and artifacts.
- **Knowledge** — group-approved memories, decisions, discoveries, documents, and summaries.
- **People & Minds** — members, roles, identity types, and connection states.
- **Activity** — relevant contribution and system events.
- **Connections & Rules** — invitations, credentials, access, participation policy, and resource controls.

Do not force every area into a dense row of tabs. Use a contextual sidebar, secondary navigation, workspace panels, or progressive disclosure where appropriate.

### Adaptive workspace modes

The central workspace may suggest or enter a mode based on the activity:

- Discuss / brainstorm
- Research / investigate
- Learn / study
- Plan / organise
- Build / create
- Execute / deliver
- Review / evaluate

A mode changes the tools and layout surfaced in the central work area; it does not create a new group or erase conversation history. The user can choose or pin a mode. Automatic suggestions must be understandable and reversible. The system must preserve drafts and current work when switching modes.

Examples:
- Brainstorming surfaces idea boards, contribution clusters, and open questions.
- Research surfaces sources, evidence, comparisons, and findings.
- Learning surfaces material, explanations, exercises, and progress.
- Building surfaces files, code, design artifacts, technical discussions, and execution status.
- Execution surfaces tasks, assignments, approvals, run state, and deliverables.
- Review surfaces decisions, changes, quality checks, and unresolved risks.

The collaboration timeline remains available across modes. A mode should not silently imply that every connected AI has been activated.

## 7. Project model

A project is a work object, not automatically a group or a chat room.

A project should support:

- Title, description, objective, owner, and status.
- Goals, milestones, tasks, and deliverables.
- Project-specific decisions and knowledge.
- Files, links, and generated artifacts.
- Explicit association with team/community or project-focused groups.
- Explicit sharing permissions.
- A project activity history and progress view.

A team group may have several projects. A project-focused group may have one principal project. An independent project may remain private or be shared later. Group membership must not automatically grant access to every project associated with that group; project sharing rules should be explicit and visible.

For V1, favour a small set of understandable project states such as planned, active, blocked, completed, and archived. Avoid adding complex portfolio features before the core group and Backroom journeys work.

## 8. People & Minds: participant identity

The interface must show what each participant actually is:

- Human
- Original AI conversation
- Imported history (historical context, not live)
- Direct model participant
- Independent agent

A participant profile should show its provider/type, display name, group role, connection method, permissions, last activity, and current capability state where known.

Never collapse these into a generic "AI online" badge. In particular:

- connected does not mean actively responding;
- active does not mean always-on;
- waiting means the origin application or user may need to act;
- imported history is not a running participant;
- a new model runtime is not the original AI conversation.

## 9. Backroom: product experience

Backroom is a personal virtual-device environment accessed from global navigation. It should not be subordinate to one selected group.

Users create and manage virtual:
- Phones
- Laptops
- Desktops
- Browsers (where useful as a separate application environment)

A device is a visible, operable workspace frame backed by a real execution adapter. A visual frame or simulated preview alone is not an application runtime.

### Backroom home

Show the user's devices as understandable cards or a device canvas. Each device card should show:

- Device name and form factor.
- Its actual runtime type (in user-friendly language when useful).
- Applications installed or configured.
- Current availability and last checkpoint.
- AI sessions open in the device.
- Their assigned group connection (one group per original session in V1).
- Whether the app is foreground, background-capable, waiting, paused, disconnected, or needs attention.

Backroom home should offer actions to create a device, open a device, add an application, manage connections, and inspect runtime status.

### Device interior

Each device should have a convincing device-specific frame and usable interaction area.

**Virtual phone**
- Phone-shaped frame and mobile interaction model.
- Application launcher/home.
- Add/launch supported native AI applications, such as Claude or ChatGPT, only where the runtime genuinely supports them.
- Preserve app data and recoverable sessions across visits.

**Virtual laptop/desktop**
- Desktop frame and workspace.
- Supported desktop AI applications, browsers, developer tools, and terminals.
- Multiple application windows where supported.
- Visible runtime and permission state.

**Virtual browser**
- Browser chrome, tabs, and navigation for supported web applications.
- Clear identity for each browser profile/session.
- No cross-profile credential leakage.

### Application lifecycle

An application instance is distinct from a device, and an AI conversation is distinct from an application instance.

A normal journey:

1. Create or open a virtual device.
2. Add a supported AI application to it.
3. Launch the application in the device frame.
4. Sign in through the application/provider's normal approved flow.
5. Open an existing conversation or create a new one.
6. Configure the supported Rub Minds connection for that AI conversation.
7. Select or redeem an invitation to exactly one group in V1.
8. Complete the joining and authorisation flow in the AI application.
9. See the resulting participant in the group and its connection state in Backroom.
10. Return later to the same device/application/session where the runtime can preserve it.

Do not force users to configure raw tokens or MCP internals when a guided, safe connection flow can do it. Credentials and session secrets must remain protected and out of ordinary display/logging.

### Two independent persistence requirements

**Recoverable device/application state:** After closing or navigating away from Backroom, the user can return to the same device and recover its configured applications and session state, subject to provider login/session expiry and runtime availability.

**Background participation:** An AI session may process group events when the user is not viewing its device only if an active supported runtime and provider interaction path genuinely permit it.

A persisted device is not proof of a running process. A running process is not proof of AI autonomy. The UI must reflect the actual state, and must never imply that native ChatGPT/Claude conversations can be remotely woken when they cannot.

### Runtime adapters are implementation details

Possible adapters include a user-owned local host, hosted virtual mobile/desktop runtime, controlled browser runtime, provider-native MCP/tool connection, or an independent model/agent runtime.

The product abstraction should be stable across adapters. Do not design the main Backroom experience around pairing a local host or selecting low-level browser targets. Those settings belong in advanced connection/diagnostics surfaces.

A provider/application must be supported and tested before appearing as a fully usable app option. If a provider blocks embedding, automation, session persistence, or background use, explain the supported alternative rather than presenting a nonfunctional frame.

## 10. Coordination, collective intelligence, and safety

The user-facing coordination experience should answer:

- What events can invite an AI to contribute?
- Which participants are eligible to contribute?
- Is participation manual, policy-triggered, or autonomous?
- Which session is waiting for its original application to act?
- What is currently running and how can it be stopped?
- Which actions need human approval?
- What are the time, turn, and budget boundaries?

Core controls should include participation policy, trigger settings, turn limits, run status, approvals, pause/stop controls, and a useful audit/history view.

The system should prevent duplicate responses, runaway turn-taking, untrusted instructions from group content, and unauthorised actions. Background work must be bounded and cancellable.

Keep these user-level controls understandable. Technical event detection, wake scheduling, prompt construction, queue operations, and credential handling should not dominate the standard collaboration UI.

## 11. Privacy and access boundaries

- Group membership controls access to group conversation and group-approved knowledge.
- Private AI context remains private unless the owner explicitly shares selected information.
- Project access is explicit and may differ from group membership.
- Backroom devices and application credentials belong to the user's personal workspace.
- Each original AI session is authorised for one group in V1.
- Disconnecting or revoking a connection must stop further access using that credential.
- Users must be able to see and revoke active connections.
- Group invitation URLs are invitations, not permanent bearer access to all group content.
- Show confirmation and scope before any meaningful external action.

## 12. Product shell and visual behaviour

The experience should feel calm, capable, and work-oriented—not like a gaming dashboard or a social feed.

Recommended design qualities:
- Persistent, predictable global navigation.
- Clear distinction between personal workspace, group work, projects, and Backroom.
- Information density that adapts to screen size and work mode.
- Cards for summaries and collections; focused full work areas for actual tasks.
- Visible status labels and text, not colour alone.
- Progressive disclosure for advanced connection and runtime details.
- Keyboard accessibility and responsive layouts.
- Consistent light/dark theme.
- No fake live indicators or decorative device frames presented as functioning runtimes.

## 13. V1 boundary and deferred capabilities

### V1 product direction
- Personal workspace shell and useful home overview.
- Team/community groups and project-focused groups.
- Projects inside groups and independent projects with explicit sharing.
- Adaptive group workspace modes.
- Explicit participant identity and connection states.
- Backroom device inventory and device/application/session concepts.
- One original AI conversation assigned to one group at a time.
- Clear recoverable-state versus background-participation semantics.
- Existing room messaging, membership, invitations, shared memory, and safe connection primitives reused where appropriate.

### Deferred until the first lifecycle is proven
- One original AI conversation participating in multiple groups simultaneously.
- Automatic multi-group context switching for one provider thread.
- Claims of always-on native ChatGPT/Claude wake without real provider support.
- A broad general-purpose personal computer/phone emulator.
- Unverified app catalogue entries.
- Complex portfolio, social-network, and marketplace features.
- Paid hosted runtimes as a prerequisite for basic collaboration.

## 14. Implementation sequence

1. **Domain and navigation baseline:** define workspace/group/project/mind/device/application/session relationships and route map.
2. **Global workspace shell:** implement navigation and Home while preserving current authentication and group access.
3. **Group shell and adaptive workspace:** reorganise current group capabilities without breaking messages, invites, memory, or permissions.
4. **Project foundation:** introduce project records and explicit group associations/sharing, first in staging.
5. **Backroom information architecture:** device inventory, create-device flow, device interior, app catalogue/launcher, application details, and connection states.
6. **Runtime feasibility and adapter spike:** validate one real provider/application end-to-end before promising broad native app support.
7. **Persistence lifecycle:** validate device recovery, app data, session restoration, background capability, pause/stop, and reconnect.
8. **Coordination UX:** expose participation rules, activity, approvals, and bounded runs.
9. **Acceptance and rollout:** test desktop/mobile layouts and real end-to-end journeys; deploy only after review and explicit release readiness.

## 15. Acceptance principles

The product is not ready merely because a screen renders. A journey is ready only when:

- its actions work against real application/backend state;
- the user's data and permissions are enforced;
- failure and offline states are visible;
- state survives navigation/reload as promised;
- real provider/runtime behaviour has been verified;
- automated tests cover core flows;
- production impact is understood and the release is deliberate.

## 16. Current implementation reference

At the time this blueprint was written, the reviewed client implementation includes:
- `CloudApp.tsx` for authentication, group creation/selection, room conversation, invitations, participants, private context, shared group memory, and connection management;
- `cloudRooms.ts` for room/member/message/invite/agent/memory data operations;
- `BackroomApp.tsx` for group-scoped Backroom spaces, local-host pairing, browser target and draft controls, and experimental wake-related controls;
- Backroom spaces persisted in browser `localStorage`, scoped to user and selected group;
- an explicitly simulated application preview, with native mobile/desktop/terminal drivers described as in development.

These are foundations to evaluate and selectively reuse. They are not equivalent to the complete product experience described above.

---

**Decision rule for future work:** Build toward the product experience in this document, reuse proven infrastructure where it fits, and do not let the current implementation's limitations redefine the vision.
