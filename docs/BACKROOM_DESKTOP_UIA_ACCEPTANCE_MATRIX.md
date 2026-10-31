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


## Single-application window capture — 2026-10-31

A Windows window capture may be interactive only when all of these conditions hold:

- The OS capture picker reports `displaySurface=window`; an unknown/missing surface type remains view-only rather than being guessed as a window.
- The selected window must belong to the exact process ID returned when Backroom launched the chosen executable. The native companion finds exactly one visible top-level UIA window for that PID, rejects the companion process, and confirms the focused HWND is that unique window.
- The captured frame dimensions match that window's native bounds within the strict geometry tolerance.
- Before each remote input action, the companion re-resolves the foreground window and requires the same HWND, process and class, with compatible bounds. A focus change, window replacement or incompatible resize rejects input.
- Drag-select and draft insertion additionally require the selected UIA text field to belong to the captured window's process and pass the existing empty-field, non-password, exact-identity and exact-readback checks.

### Manual window-capture acceptance (not yet executed)

| Scenario | Required result |
|---|---|
| Notepad / Chromium / Electron selected in OS window picker | Correct live window frame; native identity and dimensions must match before enabling control |
| The companion window is selected accidentally | Reject control |
| Two top-level windows from the same launched process are visible | Reject interactive app-window binding as ambiguous; offer monitor view or view-only instead |
| Captured window loses foreground focus | Control action rejected; restore target and re-establish capture |
| Captured window moves, resizes or is replaced | Control action rejected until capture geometry is revalidated |
| A drag rectangle lands on another process | Reject target; no draft staged |
| Capture surface type is missing or unknown | Keep stream view-only |
| User selects whole monitor | Existing full-monitor geometry path remains available |

The native source tests cover the pure geometry and window-identity checks. They do not replace Windows compilation or this physical acceptance matrix. No claim that single-window interaction is physically verified is made.

### Native app identity revalidation (2026-10-31)
The companion now records the app ID and child process ID in Rust when the approved executable starts. The browser-supplied PID is checked against that native record; it is not sufficient by itself. On every interactive action and draft targeting check, the native companion verifies that the app ID still maps to the original process, the child process is still live, and its unique window identity/focus remain valid. A browser request cannot register an arbitrary PID through the window-capture API. Native compilation and physical Windows interaction remain unverified.

## Capture source identity safety correction — 2026-10-31

The browser's `getDisplayMedia` API exposes a captured `displaySurface` category and dimensions, but not the native HWND selected in the OS picker. Matching an app's PID, focused window and dimensions does **not** prove the video stream comes from that HWND. Consequently, **single-window streams are now view-only**; the native `set_capture_geometry` command rejects interactive window input. Previously proposed single-window control scenarios above are superseded. Whole-monitor sharing remains the supported separate-approval control path. Interactive single-window support requires native capture and input bound to one verifiable HWND.

## Verification checkpoint — 2026-10-31 (PTY safety and latest CI)

- Desktop selection acknowledgement is now one-shot: a successful native selection response consumes its drag request ID. A replayed acknowledgement cannot replace the verified native selection; the branch contains a matching regression test.
- The optional native PTY transport exposes a distinct `writeDraft` method rejecting Enter, line breaks, ANSI/control sequences, blank drafts and oversized text. A test for the method is committed. This is only a transport safety primitive: a production Claude Code/OpenCode integration must still resolve and attest a specific focused assistant composer and empty buffer, and must actually call this safe method rather than the unrestricted manual `write` path.
- GitHub Actions commit `0e177ac339b0f552307e180802ad74f6428359df`: Windows desktop companion run `41189213324` and durable wake SQL run `41189213269` both reported failure. Their returned jobs had zero steps; downloading job logs returned `404 BlobNotFound`. Neither build failure root cause nor test pass is established. Do not override the failed checks or assert compiler success.
- The running environment could not reach github.com through git transport, so a full local checkout/build was not possible. The changes were written using the GitHub connector and independently re-read where noted.
- The Android guest provider remains absent; the Android admission checklist therefore remains blocking. No user-operable virtual guest app or physical acceptance is claimed.

**Release gate remains closed:** green actionable CI logs, Windows native compilation, real terminal/desktop tests, an admitted Android provider and physical device tests are still required. No production deploy or merge authorized by this checkpoint.

## Terminal TUI draft and submission flow — 2026-10-31

Claude Code and OpenCode full-screen interfaces are PTY applications, not Windows UI Automation Edit/Document controls. The companion cannot reliably infer which TUI widget is focused from terminal output. The user must visually confirm the intended prompt before enabling the separate terminal draft permission.

Implemented in the feature branch:
- Native terminal draft writes require both the active control grant and a separate, locally confirmed draft-typing grant.
- Draft payloads are limited to 4,000 Unicode characters and reject blank text, CR/LF, tabs, C0/C1 control characters and Unicode line separators. No draft operation writes Enter.
- The WebRTC message is bound to the exact PTY session already associated with that peer. The message cannot supply an alternate terminal session.
- Enter is a separate operation carrying no text. The native host permits it only after a successful draft write in that exact PTY session, consumes that permission once, and expires it after 30 seconds.
- Manual control revocation, session close and Emergency Stop remove pending Enter permission. The companion UI disables Enter if the user edits the draft after the last successful write; local draft permission expires in the UI slightly before native expiry.
- Protocol-level Node regression tests cover session binding, malformed IDs, blank/oversized input, all newline/control categories, exact-session Enter and rejection of text bundled with Enter. Rust unit tests cover the native draft validator and one-use/expiry policy.

Important boundary:
- This is a bounded PTY text-input flow, not semantic focus detection. The same text may be interpreted by the currently focused program, so the person at the computer must verify the Claude Code/OpenCode composer before approving draft typing and before pressing Enter.
- Do not claim visual drag-select targeting for a TUI. The Windows UIA drag-select path applies only to accessible desktop Edit/Document controls.
- Build and test gates remain open until the Windows native workflow executes real steps, Rust tests and MSVC compilation pass, and a physical Windows acceptance run verifies the entire path.

### Focused terminal regression checkpoint — 2026-10-31

- Node 22 isolated harness: **7/7 passed** — 3 PTY transport tests and 4 strict terminal-message protocol tests. Cases include actual CR/LF, tab, ESC/ANSI, NUL, DEL, C1 controls, Unicode line separators, blank/oversized drafts, stale/mismatched session IDs, malformed request IDs, Enter carrying text, and write attempts after PTY shutdown.
- The Node test file is included in `npm run test:companion` so the repository's Windows workflow will execute it when a runner actually starts.
- This was an isolated harness built from the current helper/test source, not the full repository test suite or Tauri WebView build.
- Rust unit tests were added to the native crate for the same validator and one-use submit marker, but **were not executed**: this environment has no `rustc` or `cargo`.
- Physical Windows validation with an actual Claude Code/OpenCode process remains unperformed. The native host cannot infer the focused TUI widget from PTY output; local approval is required for text-only drafts, and Enter is a separate explicit button action.


### Desktop targeting + terminal integration checkpoint — 2026-10-31

- A combined isolated Node 22 harness built from the current branch helper/test sources passed **22/22**: nine target-selection/serialization/replay tests, six video pointer/letterbox/drag tests, three native PTY transport tests, and four strict terminal protocol tests.
- The native companion's terminal draft permission approval text now differs by surface: a desktop screen draft describes drag-selecting one actual editable area; a terminal draft explicitly warns that text goes to the currently active PTY program and that the companion cannot identify the focused TUI widget. The user must inspect the visible terminal prompt.
- Terminal resize messages are now bound to the exact PTY session assigned to the WebRTC peer; a remote message cannot choose another session ID.
- This test result is a focused isolated harness, not a full `npm run test:companion`, Vite/TypeScript production build, Cargo unit-test run, MSVC compile, or physical Windows acceptance. Rust/Cargo are not installed in the current execution environment.
