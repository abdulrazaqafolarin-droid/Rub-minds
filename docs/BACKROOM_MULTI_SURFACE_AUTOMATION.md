# Rub Minds Backroom — Multi-surface automation foundation

**Status:** Draft PR #48, not merged and not deployed. No native OS-control capability should be claimed as available until an installed driver is verified on that device.

## Supported target contracts

| Surface | Registration contract | Local adapter | Current policy |
|---|---|---|---|
| Browser tab | Selected exact DOM node and fingerprint | `BrowserHostRuntime` with Playwright | Draft; separately authorized canonical wake only |
| Desktop application | Selected accessibility control + app/window fingerprint | `NativeAccessibilityDraftAdapter` | Draft only |
| Windows application | Selected UI Automation control + process/window identity | `NativeAccessibilityDraftAdapter` | Draft only |
| Android application | Opted-in accessibility-service node + package/activity/window identity | `NativeAccessibilityDraftAdapter` | Draft only |
| Terminal | Explicit named PTY session with a verified assistant composer | `TerminalDraftAdapter` | Draft only; raw shell commands never inferred |

`createMultiSurfaceExecutionService` provides one local host-side registry and permission guard for desktop, Windows, Android and terminal targets. It never installs a Windows, Android or PTY driver. Drivers must be injected by a trusted host installation. Browser targets are intentionally owned by `BrowserHostRuntime`, avoiding accidental cross-surface fallback.

Every registered target binds: host, group, space, original session, app, exact locator, identity fingerprint and revision. A draft checks all these fields, requires user-approved local action, invokes live host-connection and permission callbacks, probes the selected input, requires an empty composer, writes without submit and reads the text back. Per-target execution is serialized, and target registration is rechecked after asynchronous permission and immediately before invoking the OS-driver adapter. A revoked, moved, occupied or replaced target is not silently retargeted. Only the explicit `draft` operation is supported for these native/terminal contracts. In the case of a device result whose effects cannot be verified, `submitted` is **unknown** (null), `requiresReview=true`; do not silently retry.

The optional local `createBackroomHostServer({multiSurfaceRuntime})` integration adds:
- `GET /v1/surfaces/targets`: only origin-bound locally paired clients can inspect registered draft-capable targets.
- `POST /v1/surfaces/draft`: only authenticated local paired clients can request an explicitly approved draft. The host service independently checks target identity and permission.
- No HTTP endpoint for native driver installation, generic input injection, `Send`, shell execution, target cross-binding, or Android accessibility permission changes.
- If `multiSurfaceRuntime` is not supplied, both routes fail closed with an unavailable response.
- Emergency stop and server shutdown call `multiSurfaceRuntime.stop()`. The service permanently disables its registered targets after stop, requiring deliberate new local setup.

## Platform driver acceptance

**Windows/desktop:** The external driver must use official OS accessibility APIs under the user's logged-in session and verify app process, window identity and the exact selected control immediately before an atomic empty-control write. It must never focus a different app or fall back to screen coordinates without separate consent.

**Android:** A separate installed and manually enabled accessibility service must prove package/activity/window identity and explicit human input selection. No ADB root bypass, secret permissions or background screen scraping is enabled by this branch.

**Terminal:** Use a named, inspectable assistant composer buffer in a controlled PTY; never write to a raw shell prompt. Do not accept newline, carriage return, ESC, control characters, or implicit Enter/submit. Treat unknown input states as manual-review outcomes.

## Automated tests and evidence

`integrations/backroom/multi-surface-execution.node-test.mjs` checks registration consent, draft-only behavior and no-submit attestations on four native/terminal surfaces, tenant/target revision mismatch, control characters, occupied input, host disconnect, shutdown and revocation. Additional `host-server.node-test.mjs` cases check paired localhost authorization, unavailable native service, refusal of arbitrary OS driver registration and explicit approval.

The code has been committed and the new coordinator and test source **passed a JavaScript V8 syntax parse** after correcting one malformed test fixture. That does **not** mean the actual repository Node tests passed: GitHub's draft build is skipped, isolated Postgres workflow jobs have failed before steps, and there is no verified Windows, Android, native desktop or terminal device driver installed in this test environment. Full Node, Playwright, DB and device E2E release gates remain mandatory.

## Release rule

Do not advertise native execution as working merely because these contracts compile. The product must expose unavailable drivers truthfully, and only allow real device operations after explicit consent and an independently verified local driver and end-to-end test. Automated original ChatGPT/Claude conversation replies remain a separate higher-risk integration gate.
