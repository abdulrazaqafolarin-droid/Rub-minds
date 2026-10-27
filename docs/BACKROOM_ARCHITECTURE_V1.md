# Rub Minds Backroom — Shared Architecture v1

**Status:** architecture decision and protocol foundation in progress  
**Scope:** Windows + Android, designed together; local-first and revenue-first  
**Not a release claim:** no native Windows or Android controller is implemented by this document or by the shared protocol module alone.

## Product decision

Backroom is a local companion/control layer behind each Rub Minds group. It connects user-authorized sessions to the group without requiring Rub Minds to clone ChatGPT, Claude, Chrome, or a terminal. A browser is one target type—not the entire product—and a Chrome extension is not a required architectural component.

The first revenue-focused product is multi-AI collaboration for vibe coders:
1. A human creates a group and invites collaborators.
2. Supported existing AI conversations connect through their own authorized MCP/tools, or a user-approved local session connector.
3. The group shares messages, decisions, project context and tasks.
4. Backroom later exposes selected local browser, desktop and terminal sessions through a permission-controlled adapter.
5. The first release queues device-dependent work; cloud execution while a device is offline is deferred until revenue justifies its cost.

## Shared architecture

```text
Rub Minds web / group API
  groups · invitations · participants · messages · shared project context
                      │ authenticated outbound connection
                      ▼
         Local Backroom connection manager
  device pairing · session registry · action IDs · approvals · audit
                      │ platform-neutral v1 contract
              ┌───────┴────────┐
              ▼                ▼
      Windows adapter     Android adapter
      browser sessions    managed browser / supported app APIs
      Windows UIA         explicit app intents / supported APIs
      process runner      platform-permitted local actions
      local queue         local queue
              │                │
              └───────┬────────┘
                      ▼
          real user-authorized interfaces
```

The shared contract lives in `src/backroom/protocol.ts`. It defines protocol version, device/session descriptors, capabilities, bounded action requests, approval state and legal action transitions. It has no platform dependencies and does not itself open apps, inspect screens, execute commands, persist work or communicate with Supabase. This keeps the common part testable while native adapters remain small.

The local companion should make **outbound-only authenticated** connections to Rub Minds. Do not open a public listening port on the user's computer or phone. Never send raw device pairing secrets, provider cookies, browser storage, or terminal output by default to the group service.

## Two session connection modes

### Attach to an existing session

Attach is an explicit attempt to connect to a session the user already opened. A conversation URL is a locator, not proof of control or authentication. The connector must establish that it can read or act on the selected session using an authorized local interface. It must not extract cookies, reuse another app's private token store, bypass login, or silently switch to a different model conversation.

A session can be displayed as **connected** only after a verified capability probe succeeds. Otherwise show a truthful state such as waiting for user, unsupported, or failed. Provider UI changes can break automation; fail closed and require reconnection.

### Open a managed session

Managed mode opens a real supported website/app in an environment controlled by Backroom, rather than reproducing its interface. The user signs in through the provider's own UI when required. Browser profile data is isolated by group/device policy and can be explicitly disconnected or cleared.

Managed mode does not promise every site permits embedding or automation. The provider adapter must pass its own acceptance tests before the app is advertised as supported.

## Platform boundaries

### Windows

- Start with a signed-in, interactive desktop and explicit pairing.
- For browser targets, prefer a dedicated Backroom-managed profile for managed sessions. Attach to an existing browser only through a deliberate, visible local hand-off.
- Evaluate Microsoft UI Automation for supported desktop controls; it is an accessibility/testing surface, not a guarantee that every app exposes usable controls. Some input-injection actions require the target desktop to be interactive and in the foreground.
- Run terminal work with a structured executable + argument list, never by concatenating untrusted text into a shell command. Confine working directories to a user-selected workspace, display the exact executable/arguments/cwd for approval, bound time/output, and support cancellation.

Reference: [Microsoft UI Automation overview](https://learn.microsoft.com/en-us/windows/win32/winauto/entry-uiauto-win32).

### Android

- Design the adapter from the beginning, but expose only capabilities the operating system and target app actually permit.
- Prefer provider APIs, app-specific integrations, Android intents and a Backroom-managed web session where the provider supports it.
- Do not build the core product around general-purpose AccessibilityService control. Android documents accessibility services as assistive technology that users explicitly enable; Google Play policy restricts using Accessibility APIs to autonomously initiate, plan and execute actions except for qualifying accessibility tools. Any accessibility integration needs a separate legal/policy/product review and cannot be assumed approvable.
- Android background execution is system-controlled. The app must show an honest connected/waiting state and cannot promise always-on execution while suspended, force-stopped or offline.

References: [Android AccessibilityService](https://developer.android.com/reference/android/accessibilityservice/AccessibilityService), [Google Play Accessibility API policy](https://support.google.com/googleplay/android-developer/answer/10964491), and [Android foreground-service restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start).

The same JSON protocol works on both platforms; the permission model and available adapter capabilities differ. Unsupported actions return a specific failure instead of pretending they succeeded.

## Session and action contract

Every registered session identifies:
- protocol version, device ID, platform, group ID and local session ID;
- existing-session or managed-session mode;
- target kind (AI conversation, website, desktop app or terminal);
- a visible label and lifecycle status;
- a least-privilege capability list, plus timestamps.

An action includes a stable ID and idempotency key, target group/session, requester, typed payload, requested/expiry timestamps, approval fields, state, and a bounded result summary. It does **not** contain an app password or provider credential.

Initial action types:
- `read_page`: permitted only if that paired session was granted the read capability.
- `open_url`: HTTPS-only input; requires human approval. The platform adapter also needs a provider/domain policy.
- `capture_screenshot`: requires human approval; provide a preview before any sharing.
- `send_message`: requires human approval in v1; display the exact destination and body.
- `run_terminal_command`: requires human approval every time; accepts an executable, argument array and working directory, not a raw shell command string.

The shared module checks input bounds, HTTPS URL format, action expiry (maximum 24 hours), session/group scope, granted capabilities, approval and lifecycle transitions. It is a **pure contract**, not the security boundary by itself. The local runner must re-check approvals and capability grants at execution time. The cloud API must independently authorize group membership and device/session binding. A remote group message is untrusted data and never overrides local approval.

## Offline behavior and cost policy

Phase 1 is local-first:
- Device actions that cannot run while the device is disconnected remain pending and expire; they are not moved to a cloud executor.
- The group backend may retain shared messages while the local companion is offline. After reconnecting, the device fetches pending work, revalidates authorization and expiry, then asks for any required approval.
- Queue persistence should use a platform-appropriate local database; protect private data with OS-backed encryption where available. The current protocol module does not implement durable storage or offline synchronization yet.
- No cloud browser, always-on Playwright worker, paid inference, or background agent runtime is required to validate the initial value proposition.

Phase 3 can add separately budgeted cloud execution after revenue, with explicit opt-in, per-group limits, cancellation, and a cost dashboard.

## Delivery sequence

1. **Prove multi-AI collaboration first.** Create group → connect a supported ChatGPT/Claude session via its existing authorized tools → verify join → read a human message → send a reply → read it back → disconnect/revoke. Keep this separate from Backroom claims.
2. **Vibe-coding workflow.** Add a project objective, durable decisions/context, action items and links to connected conversations. Keep it lean; don't create a separate project-management system.
3. **Backroom contract and native pairing.** Land the protocol and tests, then pair a real Windows companion and an Android companion against the same session schema.
4. **One real managed-session slice per platform.** Demonstrate open/register/permission/approved action/result/cancel and reconnect behavior on disposable test groups.
5. **Existing-session attachment.** Implement provider/browser adapters only after verifying a supported, authorized mechanism. No cookie extraction or hidden takeover.
6. **Offline queue.** Add durable local persistence, expiry, idempotent replay, and explicit reconnect/conflict tests.
7. **Release gate.** All CI passes; Windows and Android acceptance tests pass on actual devices; authorization, revocation, expiry, duplicate action and sensitive-action approval tests pass; no production deploy until explicitly approved.

## Acceptance criteria for Backroom v1

- [ ] One group can register a Windows and an Android device using the same protocol version.
- [ ] Existing-session and managed-session are distinct visible modes, not marketing aliases.
- [ ] A session is not marked connected until a capability probe passes.
- [ ] Mismatched group/session IDs, missing capabilities, expired work, duplicate action IDs and stale protocol versions fail closed.
- [ ] Screenshot, navigation, message sending and terminal execution require explicit approval in v1.
- [ ] Terminal execution uses an executable + args array, never a command concatenated into a shell string.
- [ ] Device-originated credentials are not present in group messages, URLs, analytics, or logs.
- [ ] Local pending work resumes only after reconnect and fresh authorization checks; no cloud fallback is silently invoked.
- [ ] Tests clearly distinguish the shared contract from real Windows/Android/provider acceptance.
- [ ] Production remains untouched while the candidate is in review.
