# Backroom native and browser driver integration plan

Last reviewed: 2026-10-28. This document describes the current draft branch and does not assert production readiness.

## What exists in source
- Shared `TargetRegistry`, `BackroomDispatcher`, `LocalExecutionGuard`.
- A **draft-only** `BrowserDraftAdapter` for user-provided, authorized Playwright pages. Exact origin and conversation path; one visible enabled editor; empty composer; confirmed inserted text; no click Send.
- A **draft-only** `NativeAccessibilityDraftAdapter` contract for Android, Windows and desktop applications. It accepts an injected OS-specific driver with `inspect({locator})` and atomic `writeTextIfEmpty(...)`. It refuses stale app/window identity, missing focus, occupied text fields and implicit submit.
- A new **draft-only** `TerminalDraftAdapter` contract for named, inspectable terminal-editor sessions. It requires an injected driver that can inspect the exact input buffer and atomically write only when empty; it rejects CR/LF and terminal control characters, passes `submit: false`, and returns `needs_review` if the driver cannot attest that no submit occurred. Its current tests use a fake driver; it is not wired into the local host and is not an actual PTY controller.
- `mapDragToDisplay` calibrates a user drag rectangle into device-display coordinates when the host has measured dimensions and orientation. It never invents screen dimensions.
- Node contract tests, mock integrated native-host tests and an optional actual Chromium browser smoke test against a controlled localhost page.
- A responsive Backroom UI with explicitly simulated preview selection plus a separate real local-host pairing and managed-browser draft panel. Native overlays and phone/desktop/terminal drivers are **not** connected yet.

## Next platform bindings

### Android
Start with ARTEMIS (google/artemis) as a candidate **ADB-connected Android device automation backend**. Its upstream quickstart describes a Python/uv toolchain and ADB, scrcpy and FFmpeg dependencies; this is not a general permission to run invisible phone automation or install an overlay on every phone. Validate an Android 14+ physical device with explicit USB-debugging authorization. A native Android overlay/AccessibilityService is a separate Android application module requiring the owner's consent, policy review, lifecycle handling and clear Stop controls.

Use `inspect` to return package name, focused window ID, verified session, target accessibility node, current editable value and rotation. Use `writeText` to insert approved text only. Test with ChatGPT/Claude Android apps **only where OS permissions and app policies permit**; handle restricted views as unsupported.

TwinSpace documents a distinct work-profile approach for actual app-data isolation. It is not the automation driver. Work-profile provisioning and app cloning must remain optional and should never be a prerequisite for the Backroom control overlay.

### Windows / native desktop
Investigate CUA Driver (trycua/cua, `libs/cua-driver`) as a low-level computer-use backend, alongside semantic Windows UI Automation when available. CUA Spaces is a separate product and is not interchangeable with the MIT-licensed Driver. Audit current SDK APIs, module licensing and Windows runtime requirements before wiring the host.

Desktop driver must bind real process ID, window handle and accessibility node identity; do not rely on a rectangle alone. Test with the native ChatGPT and Claude apps and a controlled Windows test app, noting each native app's accessibility limitations. A pop-up, focus change, or new conversation must fail closed.

### Terminal
`TerminalDraftAdapter` now defines the attended draft-only boundary for a named terminal editor: the runtime binds a `terminal_pty` locator to `appId`, `sessionId` and `identityFingerprint`, checks the active input buffer, then requires the driver to atomically confirm an empty buffer and write with `submit: false`. It rejects multi-line/control-character input to reduce accidental command execution and returns `needs_review` when readback or the no-submit attestation is ambiguous.

**Still required:** implement and wire a real named PTY or terminal-frontend driver. A generic PTY cannot necessarily inspect a readline/editor buffer, so the driver must have a trustworthy input-buffer contract rather than guess from screen pixels. Do not synthesize Enter from a group message. Shell execution must remain a separate capability with separate approval, sandbox policy and allowlist; an AI request cannot serve as its own approval.

### Browser
Playwright is only a browser adapter and local smoke-test tool. Provider website selectors must be verified on the real logged-in page when permitted; the app does not infer access to the original hosted session from a URL or imported transcript.

## Release gates
1. `npm run test:backroom` succeeds in an actual Node process.
2. `npm run build` succeeds under the project's strict TS config.
3. `npm run test:backroom:browser` succeeds with local Chromium and no provider credentials.
4. Native and terminal drivers prove inspect -> user approval -> draft -> readback against user-controlled test apps and distinguish blocked/no-access conditions. The terminal draft contract's mocked tests do not satisfy this gate.
5. Real session identity and focus checks tested during deliberate window switching, stale sessions, rotations and disconnections.
6. Host authentication, revocation, kill switch, durable replay protection and server-side group authority reviewed before external message dispatch.
7. Production deploy separately approved. An open PR and passing mock tests do not constitute device support.

## Incremental browser in-space view (feature branch only)

The feat/rm-backroom-live-browser-view change adds the first actual in-space view adapter for tabs discovered by the paired, host-managed Playwright Chromium profile.

- The Backroom tile is created from a real pageId returned by the host's tab inventory. The Add App form no longer treats a manually typed app label as a discovered application.
- A tab's read-only snapshot permission is separate from draft insertion. The web UI requests a permission, but the trusted local host terminal must separately approve the exact tab (title and site), group scope and view-only capability. Draft insertion and autonomous wake grants each require their own trusted local terminal approval too; a remote `approved`, `ownerConfirmed` or `confirmed` field is not sufficient. Non-interactive hosts deny these requests. The view grant expires after five minutes by default and is revoked on pause, tab change, host stop or page close.
- The host returns short-lived JPEG viewport snapshots over the authenticated loopback connection. The UI refreshes them periodically and displays them in the Backroom stage. This is a read-only snapshot view, not an iframe, interactive remote desktop stream or native process embed. Images are not stored or uploaded by the app.
- Each frame has a single-use ID and is bound to the page, group, permission grant, URL, viewport size, scroll position and observed DOM revision. The selection overlay maps its drag rectangle back to the screenshot's CSS viewport. The host accepts only one visible, enabled, editable, empty field wholly inside the selected region; ambiguous, occupied or stale selections fail closed.
- The selected DOM element is retained by the existing browser target registration path. The existing BrowserDraftAdapter still revalidates the exact node, URL and empty value before insertion. Draft insertion requires its own confirmation and never presses Enter or Send.
- This path covers managed Chromium tabs only. It does not embed tabs from an unrelated Chrome profile, and it does not claim native Windows, macOS, Android or terminal views. Those remain unavailable until their respective discovery, permission and transport drivers are implemented and integration-tested.

The local browser-view API and mock tests are not physical-device or provider-account acceptance tests. A real Chromium run and actual host terminal approval are required before marking this adapter end-to-end verified.
