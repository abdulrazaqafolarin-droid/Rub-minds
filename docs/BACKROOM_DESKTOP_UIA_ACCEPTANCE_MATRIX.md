# Backroom desktop UI Automation acceptance matrix

Status: Windows UI Automation composer targeting plus local Send-control discovery/revalidation are implemented in source on the feature branch. Physical Windows acceptance, Rust tests and CI compilation are still pending.

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

## Read-only Send-control discovery and revalidation — 2026-11-03

The desktop companion now inspects the selected app's UI Automation tree locally after an editable composer has been selected. It uses one descendant `FindAll` query scoped to Button controls rather than a best-effort child/sibling scan. A query failure, more than 4,096 Buttons, or an unreadable required property invalidates the whole check; a partial scan can never be reported as a unique Send control. A candidate is accepted only when it is a visible, enabled Button in the same process and app window, has an exact accessible name of Send / Send message / Send prompt (or an unlabelled AutomationId with Send as a distinct token), and lies near the composer in both axes. Zero matches and multiple matches remain unverified. Generic Submit, Share, Send feedback, Resend, email, feedback, share, forward or reply resource IDs are rejected.

The complete Send-control identity (process ID, runtime ID, class, accessible name, AutomationId and bounds) remains in native Rust memory. DraftTarget skips both composer and Send identities during serialization; a native unit test asserts that neither identity, the selection ID nor the AutomationId can appear in its JSON representation. The WebView receives only the selected composer selection ID, a boolean and a bounded reason.

The **Recheck Send control** button sends only the selection ID and a one-use request ID. The local host rechecks that the same selected empty composer remains in the foreground app window and compares the currently discovered Send control with the original native identity. A stale composer/window, replaced or moved button, a missing/disabled/hidden button, an incomplete accessibility tree or multiple matches fails closed and invalidates the saved Send identity. A fresh drag is required to rediscover it.

This operation is read-only. It does not call UIA Invoke, click a button, send Enter, submit a prompt or grant autonomous execution. Draft insertion remains under the existing separate local OS approval and one-shot target verification. Off / On / Auto for native Windows apps remains unavailable; the durable group wake queue, local native Auto grant, one-time execution seal and no-replay recovery are not connected to this surface.

### Physical Windows Send-control acceptance matrix (NOT RUN)
- The Button query must return a complete result set. Simulate an unavailable UIA provider or a malformed/incomplete descendant query; the candidate must be unavailable rather than accepting one result from a partial scan.
- Verify an app with more than 4,096 descendant Button controls returns `accessibility_tree_incomplete` and exposes no candidate.
- Verify a Button whose `IsEnabled`, `IsOffscreen`, Name, AutomationId, bounds, process ID, runtime ID or class cannot be read makes the overall scan fail closed.
- Verify AutomationIds `sendToEmail`, `composerSendFeedback`, `sendToShare`, `forwardSendButton` and `reSendButton` are rejected.

| Scenario | Required result |
|---|---|
| One labelled Send Button near the selected empty Edit/Document | Discovery reports one candidate; no click or text change |
| One Send Message / Send Prompt Button | Accepted as an exact accessible name |
| Empty accessible name with AutomationId token `send` | Accepted only when `send` is a distinct token (e.g. `sendButton`, `composer_send_button`) |
| Submit, Share, Send feedback, Send to email, Resend | Rejected as misleading/non-exact labels |
| Disabled, off-screen or non-Button control | Rejected |
| Button in another process or outside selected app window | Rejected |
| Button far from composer horizontally or vertically | Rejected |
| No matching Send control | Draft-only status |
| Two matching Send controls | Ambiguous; neither is selected |
| Composer content becomes non-empty, app loses foreground, composer moves/replaces | Recheck fails and invalidates the Send identity |
| Send button is removed, disabled, hidden, moved or replaced | Recheck fails; no automatic rebinding |
| Duplicate/replayed recheck request or stale selection ID | Rejected without changing the current selection |
| Successful discovery and successful recheck | Status only; never invoke, click, Enter or Send |

Record physical results only after running the matrix on a real Windows 10/11 computer and an approved disposable app/group. Latest exact-head CI run `41618724844` (Windows) and `41618724559` (Android) failed before runner allocation (`runner_id=0`, empty runner name, no job steps); the durable SQL and main validation jobs did the same. No Rust/MSVC compiler result or Android Gradle result is available for this exact revision.
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
- Android's Phone Frame now has source-level live mirror, drag-select composer targeting, and local Send-control discovery/revalidation for a real foreground app. This is not an isolated virtual guest. The Android path remains draft-only and physical-device acceptance for app-window streaming, accessibility target binding, typing and Send-control revalidation is still pending.
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

### Native terminal Enter approval and race-safety — 2026-10-31

- A terminal Enter request now opens a second native operating-system Yes/No dialog on the computer. The dialog states that Enter can submit a Claude Code/OpenCode prompt or execute a shell command, and warns that the companion cannot inspect the TUI input buffer.
- The remote browser button is not authorization: a direct WebRTC message still reaches the same native confirmation gate.
- The Enter lease transitions from `Ready` to `Confirming` before the OS dialog opens. Duplicate Enter requests are rejected, and a new draft write is blocked while confirmation is pending so the text cannot change under the user's approval.
- A local denial restores the one-use lease only while its original 30-second expiry remains valid. An approval consumes the lease before PTY I/O; an ambiguous write failure never enables automatic retry.
- The native command rechecks the local control grant after the dialog and holds the control + submit-state locks through the final one-byte Enter write, so a concurrent revocation or draft cannot race between approval and delivery.
- A new authorized draft attempt retires the previous Enter lease before validation and writing. If the new draft is invalid or write fails, the old text cannot be submitted with a stale approval.
- Native Rust unit tests were added for reserve/confirm/deny/consume transitions, duplicate confirmation rejection, session binding, expiry and attempts to modify text during confirmation. These Rust tests are not yet executed in this environment because Cargo is unavailable.
- The React UI preserves Enter readiness only after an explicit local OS-dialog denial. Expiry, revocation, stale authorization and PTY I/O failures disable the button and require a fresh draft.

### Terminal request replay protection and latest focused tests — 2026-10-31

- Each native terminal WebRTC peer now owns a bounded request-ID guard shared by draft and Enter messages. An action request UUID can be claimed only once; duplicate IDs are ignored without sending a duplicate correlated response, avoiding races with the original request acknowledgement. The set is capped at 256 unique requests per PTY peer; reaching the cap fails closed and requires reconnecting that terminal session.
- The guard distinguishes accepted, duplicate, invalid and capacity-exceeded results. The guard unit tests cover cross-action one-use semantics and the capacity boundary.
- The updated isolated Node 22 helper/test harness now passes **24/24**: nine desktop target selection/queue/replay cases, three PTY transport cases, six terminal protocol/replay cases, and six video pointer/geometry cases.
- This is still an isolated Node harness based on the checked-in helper/test sources. It is **not** the complete repository test suite, Vite/TypeScript build, Rust/Cargo test run, Windows MSVC compile, or physical Windows/Claude Code/OpenCode acceptance.
- Native terminal Enter now has a mandatory second physical-computer Yes/No dialog. A remote DataChannel message or browser UI state cannot authorize Enter without that native dialog and an unexpired, session-bound one-use draft lease.

## GitHub Actions runner-provisioning diagnosis — 2026-10-31

Latest inspected PR check suite for commit `58da34e85308ac70eee05703f77da6c0aa0a1e67`:
- Windows companion job `124530754340`, run `41198957412`: failed in approximately one second, `runner_id=0`, empty `runner_name`, and `steps=[]`.
- Durable SQL job `124530754292`, run `41198957414`: failed in approximately two seconds, `runner_id=0`, empty `runner_name`, and `steps=[]`.
- Both job-log endpoints return `404 BlobNotFound`. There is no compiler, dependency-install or test output; these checks never reached a runner.
- GitHub's billing documentation states private-repository hosted-runner usage is quota-based and blocked once the included allowance is used without a valid payment method. A recent GitHub community report (2026-10-14) describes the same `runner_id=0`, no-step symptom as account Actions quota/spending-limit provisioning failure. This makes account quota/billing the leading diagnosis, but the account's actual usage and payment state are not exposed by this repository connector; confirm under **GitHub Settings → Billing & licensing → Plans and usage → Actions**. Do not change payment settings as part of this fix.
- A zero-hosted-minutes local acceptance script is now available at `scripts/run-backroom-windows-acceptance.ps1`. Run it from Windows PowerShell with Node 22, Rust stable `x86_64-pc-windows-msvc`, and Visual Studio C++ Build Tools/Windows SDK installed:
  `powershell -ExecutionPolicy Bypass -File .\scripts\run-backroom-windows-acceptance.ps1`
  It runs dependency install, the repository web build/tests, companion WebView build, Rust tests, companion regressions, and an explicit Windows MSVC check, preserving per-step logs and a JSON summary under the user's TEMP directory.
- The script has been committed but **has not been executed on Windows**. A self-hosted GitHub Actions runner is another no-hosted-minute route, but it must first be installed and registered by the repository owner; the workflow must not be switched to `self-hosted` until a matching runner is actually online.


### Native grant lifecycle, revocation races and missing acknowledgements — 2026-10-31

- `grant_control` now rechecks that the exact screen/terminal session is still live after the operating-system prompt, under the control-grant mutex, before inserting the grant.
- `grant_draft_typing` now rechecks the still-live control grant and exact live screen/terminal resource after its OS prompt. A prompt left open while the session is revoked cannot install a stale typing grant.
- Terminal stop performs a second revocation after removing the PTY. This closes the small interval between the first revocation and PTY removal in which an approval dialog could otherwise finish and reinsert a grant.
- Emergency Stop clears control grants again after taking the terminal registry, closing a grant-dialog completion race during teardown. PTY input itself holds the control, typing and one-shot submit locks through the write.
- The remote terminal UI now has a 15-second acknowledgement deadline for draft and Enter actions. If the data channel does not return an acknowledgement, the action might already have reached the computer; the UI locks further terminal input and asks the user to inspect and restart that PTY session instead of risking a duplicate.
- Current branch CI jobs have been reported as failed with no runner allocated, no job steps and no downloadable logs. This is a runner/dispatch-level failure signal, not evidence that any code step failed. A clean Windows native run is still required for acceptance.

## Vercel Sandbox verification checkpoint — 2026-10-31

### Exact revision and method

- PR: #56, branch `feat/backroom-virtualized-execution`, tested commit: `2942ae340f39c17e19bbbef2366c2014ea42b88d`.
- Source: private-branch files were fetched through the connected GitHub repository integration and copied into two fresh, short-lived Vercel Sandbox sessions. The private repository was not cloned, no GitHub token was put in the sandbox, and no application deployment was created.
- Both sandboxes used one vCPU / 2 GB RAM, a 5-minute hard timeout, `persistent:false`, and `networkPolicy: deny-all`. They were stopped after the test runs.
- Package scripts were read from the exact tested branch's `package.json`. No dependencies were installed or downloaded.

### Results

| Branch package script | Test files | Passed | Failed | Exit |
|---|---:|---:|---:|---:|
| `npm run test:companion` | 19 | 92 | 0 | 0 |
| `npm run test:multi-surface` | 3 | 31 | 0 | 0 |
| **Combined** | **22** | **123** | **0** | **0** |

The companion suite was executed from the branch's actual `npm run test:companion` script under Node v24.22.1. The multi-surface suite was executed from the branch's actual `npm run test:multi-surface` script in a second Vercel Sandbox using the Node 22 runtime.

The multi-surface cases explicitly exercise `desktop_app`, `windows_app`, `android_app`, and `terminal` draft adapters; local approval; exact app/session/window/PTY identity; stale target rejection; occupied-field protection; user-typing races; no automatic submit; and ambiguous write results returning `needs_review` rather than inviting an unsafe retry.

### What this proves — and does not prove

- It proves that the listed JavaScript/Node tests from this exact PR branch pass in a clean Linux Vercel Sandbox.
- It verifies helper/protocol logic and mocked adapter behavior. It does **not** execute actual Windows UI Automation, a real ConPTY process, a Claude Code/OpenCode TUI, Android Accessibility Services, or an Android guest VM.
- The Vercel sandbox image did not contain `rustc`, `cargo`, `clippy`, or `rustfmt`. The native Rust/Tauri crate and its native unit tests therefore remain uncompiled/unexecuted.
- The test suite does not replace a Windows host build, physical desktop/terminal acceptance, Android handset tests, or the full repository build.
- The two GitHub Actions jobs previously returned failure before allocating a runner (empty runner name, zero steps, and unavailable logs). The Vercel test results provide a successful independent Node regression result; they do not turn those GitHub checks green or remove the Windows-native release gate.

**Release gate remains closed:** keep PR #56 as draft and do not merge or deploy until native Windows compilation, Rust tests, and physical Windows/Android acceptance are completed.
