# Backroom v1 — local-first Windows + Android

## Product decision

The first revenue-focused Rub Minds release combines multi-AI collaboration with a focused workspace for vibe coders. The first demonstrable workflow remains: create a group, invite a person, connect supported AI participants, and verify actual group read/send/read-back. Backroom adds user-approved local sessions and tools; it is not a browser-extension-only product or an app-cloning system.

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
      Windows driver   Android driver
      Playwright/OS    supported app APIs,
      automation       intents / managed web
```

The protocol and session registry are platform-neutral. OS permissions, local transport, browser/app control and local approval UX belong to platform adapters. Two connection modes are distinct:

- **attach_existing** — register a session only when the user explicitly selects it and a supported local adapter can access it. A conversation URL identifies the destination; it does not grant control or prove a login.
- **managed** — open the real website or app in a Backroom-managed environment, then register it.

## Implemented foundation

- `integrations/backroom/protocol.mjs`: protocol v1 input, capability, approval and result validation.
- `integrations/backroom/offline-queue.mjs`: bounded queue engine with freshness checks and replay safeguards. Storage is injected; no secure durable adapter yet.
- `integrations/backroom/session-manager.mjs`: consent-gated session registration shared by platform drivers. It records only origin—not full private URL path/query or page title—and advertises only `session.inspect`.
- `integrations/backroom/windows-playwright-driver.mjs`: visible Chromium managed sessions with separate persistent profiles per group, exact top-level origin allowlists, context-level blocking for unregistered popup navigation before load, and popup containment. Attach-existing accepts an explicitly selected Playwright page handle; it does not automatically attach to ordinary Chrome.
- `integrations/backroom/local-executor.mjs`: validates a command against the session's group/session/capability scope and executes `session.inspect` only, returning a correlated result without the full conversation URL or query string.
- `integrations/backroom/managed-sessions.node-test.mjs`: fake-driver and fake-Chromium acceptance tests. These validate policy/state behavior, **not** real provider compatibility.

## Current behavior and limits

The Windows driver can open a managed site in a persistent group profile and inspect the live page's HTTPS origin. The local executor supports only the read-only `session.inspect` operation. It does **not** yet read or send messages inside ChatGPT/Claude, click controls, capture screenshots, run a terminal, or provide a remote device channel. The existing-session path requires a caller that already has a valid page handle.

The Android driver is **not yet implemented**. The generic manager accepts an Android-specific driver, but that is an interface seam, not a claim that an Android APK or native control layer exists.

A URL, invitation, or MCP connection does not itself grant access to another app's authenticated session. Managed profiles contain login state and history: keep them local, and never upload cookies or profile folders. The origin guard is defense in depth, not a complete browser/network sandbox.

## Platform constraints

- **Windows:** use supported app APIs or Microsoft UI Automation where available. Some UI automation requires an unlocked, interactive desktop; the driver should report when it cannot safely act. See [Microsoft UI Automation](https://learn.microsoft.com/en-us/windows/win32/winauto/entry-uiauto-win32).
- **Android:** prefer provider APIs, explicit Android intents, and supported managed web sessions. Do not make general-purpose autonomous control through AccessibilityService the default design: [Google Play policy restricts Accessibility API use for autonomous action planning/execution](https://support.google.com/googleplay/android-developer/answer/10964491) except qualifying accessibility tools. Any exception needs separate platform/policy review. Android background execution is system-controlled; see [foreground-service restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start).
- Unsupported actions should return a visible unsupported/waiting state rather than fake success.

## Command path and approval

1. A human explicitly pairs a device and selects a group/session.
2. The local host registers only capabilities actually available and approved.
3. Each command is bound to the registered group and session and checked against capability policy.
4. Sending external messages, navigation and screenshots require current approval from the trusted local approval store.
5. The adapter executes only supported actions and returns a correlated result.
6. Offline local work stays queued. On reconnect, authorization and approval are revalidated; expired or revoked work must never replay.

The protocol validator is not authentication, transport, app automation or a sandbox. A production host must authenticate the caller, keep device credentials out of payloads, use protected approval state, enforce idempotency, and audit actions. **Terminal execution is explicitly rejected in protocol v1** until a reviewed sandboxed executor exists with bounded workspace access, structured arguments, cancellation and output limits.

## Offline queue foundation

The queue engine accepts approved conversation sends and HTTPS navigation only. It enforces queue and payload limits, deduplicates request IDs, stays idle while offline, rechecks current registration/capabilities/approval before replay, expires stale work, bounds retries, validates executor results, and supports cancellation/recovery. It persists only an opaque approval reference—not the approval payload.

This is not yet durable local device behavior because the storage interface has no Windows or Android protected storage implementation. The platform adapter must keep queued data local, ensure one active drainer per store, and enforce idempotency. A crash during an external side effect may make the result ambiguous; do not claim exactly-once delivery.

## Local-first release order

1. Preserve the group/invitation/MCP flow and verify the actual join/read/send/read-back.
2. Finish a local Windows host with protected profile storage, authenticated local transport, visible managed browser UI, and explicit device pairing.
3. Add Android driver and app shell via supported APIs/managed WebView; test on a real device and fail visibly where native app control isn't permitted.
4. Wire selected, approved local actions to the queue and result display; retain terminal blocking.
5. Build the vibe-coding workspace around project context, decisions and tasks without replacing the existing group/memory model.
6. Add cloud execution only after revenue and measured cost limits justify it.

## Release gates

- All protocol, queue, session-manager and local-executor tests pass.
- No cross-group/session access or unapproved capability can be registered.
- Incoming command data cannot self-approve an action.
- Unsafe schemes, embedded URL credentials and unapproved top-level navigation are blocked.
- Session records do not expose private conversation paths, query tokens or page titles.
- Profile isolation is verified on Windows; device-level isolation and reconnection tested on Android.
- Actual ChatGPT/Claude login and session control are verified separately, with honest reporting of unsupported behavior.
- No production Supabase migration, Edge Function deployment or Vercel production deployment is part of this foundation change.
