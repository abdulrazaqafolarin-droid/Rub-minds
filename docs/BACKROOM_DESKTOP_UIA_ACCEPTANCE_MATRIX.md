# Backroom desktop UI Automation acceptance matrix

Status: native Windows UI Automation target resolution is implemented in the feature branch; physical acceptance is still pending.

## Automated gates

- [ ] Root Node test/build workflow passes.
- [ ] Bundled Tauri companion WebView builds.
- [ ] Rust native unit tests pass, including the pure target eligibility policy.
- [ ] Windows x86_64 MSVC companion compiles with the pinned UI Automation dependency.
- [ ] Companion protocol and authorization regressions pass.

## Manual Windows acceptance

Run on a real Windows 10/11 desktop with the installed Backroom companion, the paired owner account, and a disposable Rub Minds group.

| Target | Expected behavior |
|---|---|
| Windows Notepad empty text field | Drag-selection resolves to an accessible Edit control; owner approves; exact text is inserted and read back |
| Added native desktop app with UIA Edit | Same exact-control behavior |
| Chromium/WebView2 single-line composer exposing UIA Value | Same exact-control behavior through ValuePattern |\n| Multi-line Edit/Document editor exposing UIA Text | Focus the exact UIA element, send literal text to that element, then read back the exact complete text |
| Rich/custom editor without readable+writable UIA Value or Text pattern | Reject; no coordinate-only fallback |
| Password/protected field | Reject before draft staging |
| Disabled, off-screen or read-only control | Reject |
| Non-empty field | Reject; never overwrite existing content |
| App/window/control moved or replaced while approval dialog is open | Reject after identity recheck |
| Field changes between validation and insertion | Reject; no automatic retry |
| Successful draft insertion | Read back exact value; do not press Enter or Send |

Also verify whole-monitor capture geometry at 100%, 125%, 150% and 200% display scaling where available, plus a second monitor with a non-zero origin.

## Platform and scope boundaries

- This implementation is Windows-only. macOS/Linux accessibility targeting is not implemented.
- It only accepts Windows UIA Edit or Document controls that expose a writable/readable Value pattern, or a readable Text pattern with keyboard focus. Text-pattern writes are sent only through the exact focused UIA element, then read back. Other editor implementations deliberately fail closed.
- Android's current Phone Frame is selected-app inventory, not a live guest-app screen. Android virtual-app rendering, screen capture, accessibility target identification and remote target-bound insertion are not implemented. The phone overlay must remain disabled until those components and physical-device acceptance exist.
- A real Claude Code/OpenCode terminal is a PTY target, not a UIA text-field target. Terminal text-only input and explicit Enter are separate actions; the terminal does not use this desktop drag-select path.

No production migration, merge, or deployment is part of this acceptance checklist.

## Latest implementation details to verify

- The dragged rectangle must remain at least 65% inside the resolved edit/document field; a centre-point hit with a rectangle spanning neighbouring controls is rejected.
- Starting a new drag invalidates the previous native target immediately. Rejected/overflowing checks clear any previously stored target. The browser ignores replies that do not match its latest selection-attempt ID.
- Exact post-write readback is independently covered by unit tests: empty expected drafts, truncated/extra text and mismatched values must fail.

- Each browser drag has a unique attempt ID. The companion serializes up to four queued target checks per session, and the Device Frame ignores acknowledgements for superseded drags.
- The local native approval dialog runs only after the target has been resolved and rechecked.
- After approval, the companion re-resolves the exact target and uses ValuePattern for single-line fields, or focused-element Text-pattern input for multi-line editors, then reads the exact text back. It does not click the target centre or use an unscoped global keyboard action.
- The final pass re-reads the same UIA element and confirms the exact text, while retaining the enabled/visible/non-password/writable checks. Empty-value is required before insertion, not after it.

- The pre-write validator must reject any non-empty field; the post-write validator must allow only a non-empty exact match to the submitted text while still enforcing enabled, visible, non-password and writable metadata.


## Latest native selection safeguards

- A failed or new drag clears the previously stored target before validation.
- A queue-overflow rejection also clears the previous native target.
- Each drag is tagged with a unique attempt ID; the browser ignores any reply for an older selection.
- The native driver uses half-open pixel rectangles for the drag area and UIA field bounds; the selected rectangle must be at least 65% covered by the one resolved editable control.
- The final read-back helper must match the exact non-empty submitted draft and reject truncation, extra content or an empty expected value.


## Current selection and approval lifecycle

- Every accepted native drag gets a locally generated selection ID that is not accepted from the browser payload.
- A fresh, authorized drag clears the prior target and pending drafts for that session before the new target is validated.
- Draft approval rechecks that the active selection ID and full UIA control identity still match the pending draft both before and after the native Yes/No dialog.
- The local approval card and native dialog display the destination process ID, control type/class and whether Value or Text access will be used.
- Changing the selection removes obsolete local approval cards and returns a cancellation result to the browser session.
