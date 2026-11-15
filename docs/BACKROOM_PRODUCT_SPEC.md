# Rub Minds Backroom — Product Specification (v0.1)

**Status:** Agreed product direction; runtime implementation still requires validation  
**Decision date:** 2026-11-15  
**Parent:** [Product Experience Blueprint](PRODUCT_EXPERIENCE_BLUEPRINT.md)

## 1. Product definition

Backroom is the user's personal virtual-device environment inside Rub Minds.

It is a place to create and operate virtual phones, laptops, desktops, and browser environments that host usable AI applications. The purpose of these environments is to let the user access their existing AI applications and conversations, connect those conversations to Rub Minds groups, and maintain their application/session state for continued collaboration.

Backroom is **not** primarily:
- a local-host pairing screen;
- a browser automation dashboard;
- a collection of decorative device mockups;
- a general leisure phone or personal computer emulator;
- a guarantee that every AI application can run or remain active in the background.

Local hosts, browser sessions, hosted runtimes, and other execution mechanisms are adapters that may power the product. The user's primary mental model is devices → applications → AI conversations → authorised group connection.

## 2. Core objects

| Object | Definition | Example |
|---|---|---|
| Backroom device | Persistent virtual environment owned by a user | "Claude Phone", "AI Developer Desktop" |
| Device runtime | Actual environment that renders and executes device applications | Managed Android runtime, desktop VM, browser runtime, user-owned host |
| Application definition | Supported AI or developer application available to add | Claude, ChatGPT, supported AI desktop app |
| Application instance | A configured instance of an application on a specific device | Claude installed in "Claude Phone" |
| Provider account session | The user's authenticated session with the third-party application | Signed-in Claude account |
| AI conversation session | A specific original thread/conversation inside the application | "JUPEB Chemistry revision" |
| Group connection | Authorised connection between an AI conversation and a Rub Minds group | Claude conversation joined to JUPEB Learning Team |
| Execution adapter | Mechanism that operates, persists, or wakes the application/runtime | Browser bridge, local host, hosted runtime, provider-native tools |

These are separate objects. A device can contain multiple application instances. An application instance may expose multiple conversations. Each original AI conversation is a separate potential Rub Minds participant.

## 3. V1 group assignment rule

**One original AI conversation is dedicated to one Rub Minds group at a time.**

This is a deliberate V1 simplification:
- Each AI conversation connection has one explicit group assignment.
- The joining flow should make the target group obvious before authorisation.
- A session's group context, memory, messages, and permissions must not bleed into another group.
- To use the same provider/app in another group, the user should connect a different conversation/session in V1.
- Reassigning a conversation from one group to another should be an explicit disconnect/revoke then new authorisation flow, with clear warnings about what context and connection state will change.
- Future multi-group membership can be explored after the one-group lifecycle is proven.

Do not infer that an entire provider account, application installation, or device is a member of a group. The group participant is the specific authorised conversation/session identity.

## 4. Primary navigation and screens

Backroom is reached from the global Rub Minds navigation, not solely from inside a group.

### 4.1 Backroom home

Purpose: see and manage the user's virtual devices.

Recommended layout:
- Page header: Backroom, short purpose statement, create-device action.
- Device collection: cards or canvas tiles, filterable by phone/laptop/desktop/browser.
- Each card: device identity, form factor, runtime state, installed AI apps, active conversations, assigned groups, last checkpoint, and actions.
- Recent application/session activity.
- Attention area for failed runtime, expired sign-in, waiting AI session, stopped process, or permission required.
- A concise runtime overview; advanced adapter details remain tucked away.

Primary actions:
- Create device
- Open device
- Rename device
- Add application
- Inspect sessions
- Pause/resume where supported
- Stop runtime
- Remove device (with data/session consequences explained)

### 4.2 Create-device flow

1. Choose a form factor: phone, laptop, desktop, or browser.
2. Name the device.
3. Select an available runtime type if more than one is supported.
4. Show a plain-language explanation of persistence, availability, privacy, and resource implications.
5. Create/provision the runtime.
6. Open the new device in its frame when it is genuinely ready.

Do not display a device as "ready" while only a local layout record has been created. Show provisioning, unavailable, failed, and ready as distinct states.

### 4.3 Device interior

The device interior is the main Backroom workspace for that device.

It should include:
- Device-specific frame and controls.
- A real application surface (not a fake preview).
- App launcher/library.
- Installed/running applications.
- AI conversations/sessions discovered or opened through the application, where supported.
- Group connection details for the selected conversation.
- A compact runtime status and reconnect/stop controls.
- Optional diagnostics behind an advanced/details action.

The phone should feel like a phone; a laptop/desktop should feel like a desktop; a browser should feel like a browser. Do not force all form factors into the same generic window.

### 4.4 Application library and installation

The library should list only applications that have a defined, tested execution path for the selected runtime.

An application listing should communicate:
- Provider and application name.
- Supported form factors/runtimes.
- Whether it is web, native mobile, native desktop, or a terminal tool.
- Whether sign-in is user-managed.
- Whether original conversation connection is supported.
- Whether session persistence is supported.
- Whether background participation is supported, experimental, or unavailable.
- Known restrictions and required approvals.

Adding an application should produce an application instance tied to the chosen device. Removing an app should explain whether its data and saved session state will be retained or deleted.

Do not list an app as fully supported merely because its website can be opened in a generic browser frame. Do not bypass provider authentication, security challenges, terms, or access restrictions.

## 5. Main user journey: connect an original AI conversation

1. User opens Backroom.
2. User opens an existing virtual device or creates one.
3. User adds and launches a supported application, such as Claude or ChatGPT, in that device.
4. User signs in through the application's normal approved authentication flow.
5. User opens the specific existing conversation they want to bring into Rub Minds.
6. User selects "Connect to a Rub Minds group" from a guided connection action.
7. User selects or opens an invitation for exactly one target group.
8. The UI explains what this conversation will share, what the group can access, which actions are possible, and what requires approval.
9. The original AI conversation receives/configures the supported Rub Minds MCP or tool connection using the supported provider workflow.
10. The AI explicitly completes the authorised join operation.
11. Rub Minds shows the resulting original-session participant in the group.
12. Backroom shows the conversation's group assignment and verified capability state.

Important:
- A group invitation URL alone does not install tools, grant provider permissions, or make a conversation autonomous.
- The user must not be asked to paste long-lived secrets into public messages or ordinary UI fields.
- The original conversation's identity must remain distinct from a model-generated continuation or imported-history participant.
- The UI must be honest when connection is manual, tool-mediated, browser-assisted, or unavailable.
- A connection should not be marked complete based solely on copying a prompt or opening an invitation page.

## 6. Session lifecycle and status vocabulary

Device lifecycle and AI session lifecycle must be tracked separately.

### Device/runtime states

- Created — device record exists; runtime has not been provisioned.
- Provisioning — runtime is being prepared.
- Ready — runtime is available and can open the device.
- Running — runtime currently has an active process.
- Suspended — runtime state is saved and process is not active.
- Unavailable — runtime cannot currently be reached.
- Failed — provisioning or runtime operation failed.
- Stopped — runtime intentionally stopped.

### Application states

- Available — application can be added for this device/runtime.
- Installing — installation/configuration underway.
- Installed — application instance exists.
- Launching — application is starting.
- Open — application currently displayed/foregrounded.
- Background — application process is active but not foregrounded, if supported.
- Signed out / sign-in required — provider authentication is unavailable or expired.
- Failed — application did not launch or encountered an error.
- Removed — application instance removed.

### Original AI conversation connection states

- Not connected
- Connection setup
- Authorisation required
- Joining
- Connected — group access is verified, but not necessarily processing events.
- Active — currently participating in a bounded interaction.
- Background-capable — a supported runtime has verified ability to process eligible group events while not viewed.
- Waiting — needs origin-app/user action, provider action, or an explicit manual relay.
- Paused — connection remains but participation is disabled.
- Disconnected — no current usable connection.
- Revoked — its group credential/access has been explicitly revoked.
- Failed — connection or participation attempt failed.

A status should be backed by recent evidence/heartbeat and should show a last-seen/last-verified time where meaningful. Never equate connected with active or active with always-on.

## 7. Persistence requirements

### 7.1 Recoverable device and application state

The user should be able to leave Backroom, close the browser or return another day and recover:
- The device identity and configuration.
- Installed/configured application instances.
- The selected/last-opened app and window layout where possible.
- Provider sign-in/session state where permitted by the app/runtime.
- The user's association between a specific AI conversation and one group.
- A meaningful checkpoint and last-known status.

Persistence depends on the actual runtime and provider session rules. Expired provider sessions may require sign-in again. The interface should show the difference between saved configuration and a currently running process.

### 7.2 Background participation

Background participation is a separate capability. It requires:
- A live runtime capable of executing the application or a provider-supported original-session tool connection.
- A supported route for receiving eligible group events.
- An explicit participant/group permission policy.
- Bounded work (turn, time, cost/resource limits where relevant).
- Duplicate prevention, loop prevention, audit events, and cancellation.
- A clear pause/stop/revoke path.
- Recovery semantics for interrupted or ambiguous actions.

The product should not promise that a native ChatGPT or Claude conversation can be woken from an idle/closed provider session unless a real, supported integration demonstrates this. A persisted session locator or imported memory is not a wake mechanism.

## 8. Connection and security model

- Device ownership is scoped to the Rub Minds user.
- Provider accounts are controlled by the user and authenticated through approved flows.
- Group access is granted to a specific conversation/session participant, not automatically to the whole device or provider account.
- Each V1 group connection uses a scoped, revocable credential.
- Secrets must be protected in storage, transmitted securely, and excluded from logs/analytics/UI snapshots.
- Group membership must be explicitly authorised.
- Backroom should show the target group and connection scope before joining.
- Users can inspect, pause, disconnect, or revoke the connection.
- Revoke must invalidate access, not merely hide the UI connection.
- Host/device execution permissions must be least-privilege and separately approved where necessary.
- Group messages and external content are untrusted input; external actions need scoped tools and human approval according to policy.
- A failed/uncertain execution must not be blindly retried if it may have partially completed an external action.

## 9. Device runtime adapters

The architecture should support multiple adapters behind a common Backroom product model.

| Adapter family | Intended use | Important boundary |
|---|---|---|
| User-owned local host | Reuse apps/tools on a device the user controls | Only runs while host/device is available; pairing is advanced infrastructure |
| Controlled browser runtime | Operate supported web AI applications | Requires supported browser, login, permission, and provider-compatible controls |
| Virtual mobile runtime | Run real supported mobile AI applications in a phone frame | Requires an actual mobile OS/runtime, application distribution, and persistent app data |
| Virtual desktop runtime | Run desktop AI software in a desktop frame | Requires a real desktop/VM/container and process/data lifecycle |
| Provider-native tools/MCP | Let an original provider conversation interact with Rub Minds | Does not itself provide a device frame or guarantee background wake |
| Independent model/agent runtime | Run separate agents/models in a controlled environment | Must be labelled as independent, not the original conversation |

The user experience should not expose every adapter detail by default. Advanced diagnostics may show which adapter is powering a device and what capabilities it has.

A low-cost, bring-your-own-runtime path should be explored first. Hosted execution may be optional where feasible, not silently assumed free.

## 10. V1 boundaries and exclusions

V1 will:
- Treat Backroom as a workspace-level destination.
- Support the conceptual hierarchy device → application instance → AI conversation → one group connection.
- Show a device inventory and form-factor-specific interiors.
- Provide a real tested route for at least one AI application/runtime before claiming usable app support.
- Persist device/application metadata and recoverable session state where the adapter supports it.
- Distinguish foreground, background-capable, waiting, paused, disconnected, and revoked states.
- Keep local hosts and browser connections as optional execution adapters rather than the product's dominant mental model.

V1 will not:
- Attach one original AI conversation to multiple groups simultaneously.
- Pretend a simulated device or screenshot is an executable application.
- Promise that all native mobile/desktop AI apps can run in an embedded frame.
- Promise background participation when the provider/runtime cannot wake or process work.
- Act as a general-purpose leisure phone/desktop.
- Bypass provider authentication or supported access controls.

## 11. Implementation milestones

### B1 — Backroom product shell
- Global Backroom route and navigation.
- Device inventory with empty/loading/error states.
- Create-device flow and device record.
- Device cards with true runtime status.
- No fake "running" indicators.

### B2 — Device and application model
- Device, runtime, application definition, application instance, provider session, AI conversation session, and group connection boundaries.
- Application catalogue filtered by verified runtime compatibility.
- Add/remove/launch application UX.
- Secure ownership and permission rules.

### B3 — One real application adapter
- Select the lowest-cost feasible, provider-compliant adapter.
- Prove one supported AI application can be opened and interacted with inside its virtual device.
- Verify sign-in/session retention and reload recovery.
- Record limitations before generalising.

### B4 — Original conversation group join
- Guided invitation/MCP connection.
- Explicit one-group assignment.
- Verified original-session participant appears in group.
- Revoke/disconnect and reconnect tested.

### B5 — Background lifecycle
- Prove eligible group event can reach a real active runtime.
- Show background-capable only after a verified test.
- Bounded participation, pause/stop, idempotency, audit, and recovery.
- Validate behaviour when Backroom UI is closed.

### B6 — Multi-device and acceptance
- Multiple persistent devices with independent app/session state.
- Responsive frames and accessible device controls.
- Failure, offline, expired sign-in, pause, stop, and recovery acceptance tests.
- Staging validation before any production release.

## 12. Initial acceptance criteria

Backroom's first meaningful release should demonstrate, end-to-end:

1. A user creates a virtual device and can return to it after navigating away and reloading.
2. The device displays a real application through a real supported runtime, not a simulated preview.
3. The user can sign in through the application's normal approved flow.
4. The user can open a specific original AI conversation.
5. The user can authorise that conversation to join one target Rub Minds group.
6. The group shows the correct participant identity and truthful connection status.
7. The user can return to Backroom and see the same device/application/session association.
8. The user can pause, disconnect, and revoke the group connection.
9. Unsupported provider/runtime behaviour is clearly reported.
10. Background participation is claimed only after a verified real-runtime test.

## 13. Existing implementation to reuse selectively

The reviewed `BackroomApp.tsx` currently provides:
- group selection and group-scoped workspace spaces;
- local host pairing and capability checks;
- browser page/target discovery and browser draft insertion;
- hosted session/wake binding and explicit grant-related controls;
- a simulated preview that explicitly states the application is not yet connected.

The current `Space` record is a local layout object persisted in `localStorage`, not a durable virtual device runtime or installed application. The current preview is deliberately simulated. These parts may be useful as adapter/diagnostics experiments, but they do not satisfy the virtual-device product definition.

The redesign should preserve and reuse the security, host authorization, emergency stop, and bounded wake controls where appropriate. Their low-level configuration should move behind a clear connection/advanced area rather than defining Backroom's main navigation.

---

**Backroom's defining test:** Can a user open a virtual device, operate a real supported AI application, connect one original conversation to one group, leave, return, and find that the device/session relationship is recoverable—with background participation clearly distinguished from simple persistence?
