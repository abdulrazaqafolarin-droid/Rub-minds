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
| Chromium/WebView2 composer that exposes UIA Edit/Document Value | Same exact-control behavior |
| Rich/custom editor without readable+writable UIA Value pattern | Reject; no coordinate-only fallback |
| Password/protected field | Reject before draft staging |
| Disabled, off-screen or read-only control | Reject |
| Non-empty field | Reject; never overwrite existing content |
| App/window/control moved or replaced while approval dialog is open | Reject after identity recheck |
| Field changes between validation and insertion | Reject; no automatic retry |
| Successful draft insertion | Read back exact value; do not press Enter or Send |

Also verify whole-monitor capture geometry at 100%, 125%, 150% and 200% display scaling where available, plus a second monitor with a non-zero origin.

## Platform and scope boundaries

- This implementation is Windows-only. macOS/Linux accessibility targeting is not implemented.
- It only accepts Windows UIA Edit or Document controls that expose the required Value pattern. Other editor implementations deliberately fail closed.
- Android's current Phone Frame is selected-app inventory, not a live guest-app screen. Android virtual-app rendering, screen capture, accessibility target identification and remote target-bound insertion are not implemented. The phone overlay must remain disabled until those components and physical-device acceptance exist.
- A real Claude Code/OpenCode terminal is a PTY target, not a UIA text-field target. Terminal text-only input and explicit Enter are separate actions; the terminal does not use this desktop drag-select path.

No production migration, merge, or deployment is part of this acceptance checklist.
