# Backroom v1 — local-first Windows + Android

## Product decision

The first revenue-focused Rub Minds release combines multi-AI collaboration with a focused workspace for vibe coders. The first demonstrable workflow remains: create a group, invite a person, connect supported AI participants, and verify actual group read/send/read-back. Backroom adds user-approved local sessions and tools; it is not a browser-extension-only product.

## Architecture

```text
Rub Minds group + existing MCP gateway
                 │ authenticated request/result
                 ▼
        Shared Backroom protocol v1
                 │
       Local platform-specific host
            ┌────┴────┐
            ▼         ▼
         Windows   Android
         adapters  adapters
```

The protocol is shared. OS permissions, session discovery, browser/app control and local approval UX belong to platform-specific adapters. Support two connection modes:

- **attach_existing** — register an existing session only when the operating system and application permit authorized attachment.
- **managed** — open the real supported interface in a Backroom-managed environment, then register it.

A URL, invitation, or MCP connection does not itself grant access to another app's authenticated session.

## Platform constraints

- **Windows:** use supported app APIs or Microsoft UI Automation where available. Some UI automation requires an unlocked, interactive desktop; a Windows adapter must report when it cannot safely act. See [Microsoft UI Automation](https://learn.microsoft.com/en-us/windows/win32/winauto/entry-uiauto-win32).
- **Android:** prefer provider APIs, explicit Android intents, and supported managed web sessions. Do not make general-purpose autonomous control through `AccessibilityService` the default design: Android requires users to explicitly enable these services, and [Google Play policy restricts Accessibility API use to autonomously initiate, plan and execute actions](https://support.google.com/googleplay/android-developer/answer/10964491) except qualifying accessibility tools. Any exception needs a separate product/policy review. Android background execution is system-controlled; see [foreground-service start restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start).
- When an app or OS does not expose the needed capability, show `unsupported` or `waiting_for_user` rather than claiming control. These limitations do not change the shared protocol.

## Command path

1. A human explicitly connects a device and selects the target group/session.
2. The local host registers only capabilities that are actually available and approved.
3. Each command is bound to the registered group and session and checked against the capability allowlist.
4. Side-effecting commands (sending external messages, navigation and screenshots) require current approval from the trusted local approval store.
5. The platform adapter executes only supported actions and returns a correlated result.
6. Offline local work stays queued. On reconnection, the host revalidates access and approval before execution; expired or revoked work is not replayed.

The protocol validator is not authentication, transport, app automation or a sandbox. The host must authenticate callers, keep device credentials out of command payloads, use a trusted approval store, enforce idempotency, and audit actions. **Protocol v1 explicitly rejects terminal execution** until a separately reviewed sandboxed executor is released with bounded workspace access, cancellation, output limits and audit records.

## Offline queue foundation

`integrations/backroom/offline-queue.mjs` provides a storage-agnostic single-host queue engine for approved conversation sends and HTTPS navigation. It queues only those allowlisted actions, enforces limits and deduplication, does not execute while offline, rechecks the session/capabilities/trusted approval at replay, expires stale actions, bounds retry count, validates results, and supports cancellation. It persists only an opaque approval reference rather than the approval payload.

This is **not yet durable local device behavior** because no Windows or Android storage adapter/local host is included. The storage adapter must protect queued content, avoid cloud syncing by default, and guarantee one active drainer per store. A crash during a side effect can make the outcome ambiguous; retries are at-least-once, so the platform adapter must enforce idempotency and avoid duplicate posts. Old or revoked approvals are never reused.

## Local-first release order

1. Keep the existing group/invitation/MCP workflow as the first proof and verify the actual result, not just successful page navigation or tool discovery.
2. Implement a Windows local host with authenticated loopback IPC and a managed browser adapter. Test against a controlled local provider before any real signed-in account.
3. Implement Android-specific adapters with explicit Android permissions. Fail visibly when cross-app control is unavailable; do not promise control of every native app.
4. Add the vibe-coding workspace around project context, group decisions, and tasks. Terminal execution stays disabled until a sandboxed executor is separately reviewed and tested.
5. Implement platform-protected queue storage and reconnect tests; then consider additional local actions.
6. Add cloud execution only after revenue and measured cost limits justify it.

## Release gates

- Protocol and queue tests pass on every change.
- No cross-group/session command or undeclared capability can run.
- Incoming command data cannot self-approve an action.
- Stale, future-dated, mismatched or expired approvals are rejected.
- Unsafe schemes and URLs with embedded credentials are rejected.
- Reconnect never bypasses approval expiry/revocation; duplicates are controlled with idempotency keys.
- Windows and Android are tested separately, then through the same group workflow.
- No production Supabase migration, function deployment, or Vercel production deployment is part of this foundation change.
