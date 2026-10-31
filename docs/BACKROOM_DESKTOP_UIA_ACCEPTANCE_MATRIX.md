# Backroom desktop UI Automation acceptance matrix

Status: Windows UI Automation targeting is implemented in the feature branch. Physical Windows acceptance and CI compilation are still pending.

## Automated validation gates

- [ ] Root Node tests and production web build.
- [ ] Bundled Tauri companion WebView build.
- [ ] Rust native unit tests, including target eligibility, drag-coverage and exact post-write readback tests.
- [ ] Windows x86_64 MSVC compile with the pinned `uiautomation = 0.25.1` dependency.
- [ ] Companion protocol and authorization regression tests.

## Focused local validation completed

- [x] 8 desktop target-selection tests, including stale acknowledgement rejection, selection-ID binding, serialization order, queue recovery after a failed native operation, and invalid queue arguments.
- [x] 4 video overlay geometry tests, including portrait monitor letterboxing, landscape full-frame mapping, vertical letterboxing and invalid geometry rejection.
- These 12 tests were run with Node 22 against local copies whose Git blob hashes match the current repository helper/test files. They do not replace the full repository test suite or a Windows-native compile.

## Live video overlay regression — 2026-10-31

- The browser now waits for actual decoded video data and non-zero intrinsic dimensions before enabling drag targeting. An SDP answer alone does not make the frame targetable.
- Incoming WebRTC video is retained if its track arrives before React mounts the conditional video element. Stale peer tracks are ignored; ended, stalled, waiting, emptied or errored video disables targeting.
- Pointer coordinates are normalized against the real `object-fit: contain` video rectangle, not the surrounding frame. Letterbox/outside points and tiny or malformed drags are rejected; an outside release clears the visible selection.
- Cancelling the overlay or closing the peer retires both target and draft request IDs so delayed results cannot be mistaken for the active selection.
- Six geometry/pointer cases now exist in the repository test file (four original geometry cases plus two pointer/drag cases). An isolated Node 22 scratch harness exercising these six cases and the eight target-selection/queue cases passed **14/14**. This was not the full repository `npm run test:companion` or a TypeScript/native build.

## Current CI limitation — 2026-10-31

- The latest PR checks are marked failed, but every returned job has an empty step list and the job-log endpoint returns `BlobNotFound`. There is no executable compiler or test output to classify as a code failure or success.
- Full repository tests/build, Tauri bundle build, Windows native compile and physical Windows acceptance remain release gates.

## Manual Windows acceptance

Run on a real Windows 10/11 desktop with the installed Backroom companion, paired owner account, and a disposable Rub Minds group.

| Target | Expected behavior |
|---|---|
| Windows Notepad empty text field | Resolve to an accessible Edit control; owner approves; exact text is inserted and read back |
| Added native desktop app exposing UIA Edit | Same exact-control behavior |
| Chromium/WebView2 single-line composer exposing UIA Value | Use ValuePattern; read back exact value |
| Multi-line Edit/Document editor exposing UIA Text | Focus the exact UIA element, send literal text to that element, then read back exact complete text |
| Rich/custom editor without readable/writable UIA Value or Text | Reject; no coordinate-only fallback |
| Password/protected field | Reject before draft staging |
| Disabled, off-screen or read-only control | Reject |
| Non-empty field | Reject; never overwrite existing content |
| App/window/control moved or replaced while approval dialog is open | Reject after identity recheck |
| Field changes between validation and insertion | Reject; no automatic retry |
| Successful draft insertion | Read back exact value; do not press Enter or Send |

Also verify whole-monitor capture geometry at 100%, 125%, 150% and 200% display scaling where available, plus a second monitor with a non-zero origin.

## Safety and lifecycle guarantees

- The drag rectangle must be at least 65% covered by one resolved editable control. A centre-point hit with a rectangle spanning neighbouring controls is rejected.
- Each accepted native drag gets a native-generated selection ID only after accessibility validation; the browser cannot supply or override it. Pending-draft summaries carry that exact ID, and delayed list responses are ignored unless it still matches the active field.
- Every browser drag carries a UUID request ID. The companion serializes up to four checks per session, and the Device Frame ignores replies for superseded drags. Rejected/overflowed attempts are retired and cannot later be confirmed.
- A fresh, authorized drag clears the previous target and pending drafts for that session before validating the new target. A queue-overflow rejection clears and retires its attempt ID too. Ordinary remote click/key input and peer-session teardown also invalidate the target and cancel local approval cards. Only one pending draft is permitted per selected field.
- Draft approval rechecks the active selection ID and complete UIA identity both before and after the native Yes/No confirmation dialog.
- The local approval card and native dialog show the destination process ID, control type/class and Value-vs-Text write mode.
- ValuePattern is used for single-line fields. Multi-line editors with readable TextPattern use the exact UIA element's focused `send_text` operation, then read back the exact value.
- Text insertion is one-shot. The selected target is consumed before writing; ambiguous outcomes require inspection, not automatic retry. Backroom never sends Enter or Send.
- Exact post-write readback rejects empty expected drafts, truncation, appended text or mismatched content.

## Platform and surface boundaries

- This implementation is Windows-only. Equivalent macOS/Linux accessibility drivers are not implemented.
- Only Windows UIA Edit or Document controls with writable/readable Value access, or readable Text access plus keyboard focus, are accepted. Unsupported custom editors fail closed.
- Android's current Phone Frame shows selected-app inventory only. No virtual guest app is rendered there; Android screen capture, accessibility target identification and remote target-bound insertion are not implemented. The phone drag-select overlay must remain unavailable until those components and physical-device acceptance exist.
- Claude Code/OpenCode terminals are PTY targets, not UIA text fields. Terminal text-only input and explicit Enter remain separate actions and do not use this desktop drag-select path.

No production migration, merge to `main`, or deployment is part of this acceptance checklist.
