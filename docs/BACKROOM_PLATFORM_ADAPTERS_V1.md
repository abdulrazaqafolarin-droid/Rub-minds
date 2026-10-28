# Backroom native and browser driver integration plan

Last reviewed: 2026-10-28. This document describes the current draft branch and does not assert production readiness.

## What exists in source
- Shared `TargetRegistry`, `BackroomDispatcher`, `LocalExecutionGuard`.
- A **draft-only** `BrowserDraftAdapter` for user-provided, authorized Playwright pages. Exact origin and conversation path; one visible enabled editor; empty composer; confirmed inserted text; no click Send.
- A **draft-only** `NativeAccessibilityDraftAdapter` for Android, Windows and desktop applications. It accepts an injected OS-specific driver with `inspect({locator})` and `writeText({locator,text,appId,sessionId})`. It refuses stale app/window identity, missing focus, occupied text fields and implicit submit.
- `mapDragToDisplay` calibrates a user drag rectangle into device-display coordinates when the host has measured dimensions and orientation. It never invents screen dimensions.
- Node contract tests, mock integrated native-host tests and an optional actual Chromium browser smoke test against a controlled localhost page.
- A responsive Backroom UI with explicitly simulated selection. Real host pairing, native overlays and phone/desktop drivers are **not** connected yet.

## Next platform bindings

### Android
Start with ARTEMIS (google/artemis) as a candidate **ADB-connected Android device automation backend**. Its upstream quickstart describes a Python/uv toolchain and ADB, scrcpy and FFmpeg dependencies; this is not a general permission to run invisible phone automation or install an overlay on every phone. Validate an Android 14+ physical device with explicit USB-debugging authorization. A native Android overlay/AccessibilityService is a separate Android application module requiring the owner's consent, policy review, lifecycle handling and clear Stop controls.

Use `inspect` to return package name, focused window ID, verified session, target accessibility node, current editable value and rotation. Use `writeText` to insert approved text only. Test with ChatGPT/Claude Android apps **only where OS permissions and app policies permit**; handle restricted views as unsupported.

TwinSpace documents a distinct work-profile approach for actual app-data isolation. It is not the automation driver. Work-profile provisioning and app cloning must remain optional and should never be a prerequisite for the Backroom control overlay.

### Windows / native desktop
Investigate CUA Driver (trycua/cua, `libs/cua-driver`) as a low-level computer-use backend, alongside semantic Windows UI Automation when available. CUA Spaces is a separate product and is not interchangeable with the MIT-licensed Driver. Audit current SDK APIs, module licensing and Windows runtime requirements before wiring the host.

Desktop driver must bind real process ID, window handle and accessibility node identity; do not rely on a rectangle alone. Test with the native ChatGPT and Claude apps and a controlled Windows test app, noting each native app's accessibility limitations. A pop-up, focus change, or new conversation must fail closed.

### Terminal
Build a separate named PTY session adapter with a control distinction between **draft text** and **execute command**. Do not synthesize the Enter key from a group message. Shell execution requires explicit, separate operation approval and an execution sandbox; an AI model request cannot serve as its own approval.

### Browser
Playwright is only a browser adapter and local smoke-test tool. Provider website selectors must be verified on the real logged-in page when permitted; the app does not infer access to the original hosted session from a URL or imported transcript.

## Release gates
1. `npm run test:backroom` succeeds in an actual Node process.
2. `npm run build` succeeds under the project's strict TS config.
3. `npm run test:backroom:browser` succeeds with local Chromium and no provider credentials.
4. Native drivers prove inspect -> user approval -> draft -> readback against user-controlled test apps and distinguish blocked/no-access conditions.
5. Real session identity and focus checks tested during deliberate window switching, stale sessions, rotations and disconnections.
6. Host authentication, revocation, kill switch, durable replay protection and server-side group authority reviewed before external message dispatch.
7. Production deploy separately approved. An open PR and passing mock tests do not constitute device support.
