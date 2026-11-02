# Backroom Android live app stream — physical acceptance

Status: **The baseline PR #62 Android unit-test, merged-manifest and debug-APK jobs passed. The new artifact-export workflow has not yet executed on its exact PR head (failed jobs returned no runner logs), so no artifact is available; physical handset acceptance is pending.**

This checklist covers the Android real-app mirror, remote touch and remote text entry into the currently focused phone field. It does not certify Android guest virtualization, isolated app data, guest-only frames or accessibility field discovery.

## Exact CI artifact and build boundary

The Android companion workflow now builds a compile-verification debug APK with both `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` explicitly empty. On a successful run it verifies the APK signature and merged-manifest audit, writes an artifact provenance file and uploads the APK plus its audit/signature evidence as a GitHub Actions artifact (seven-day retention).

For a physical test, download the artifact from the **same commit's** successful `Backroom Android companion` workflow run. Use its `acceptance-manifest.txt` to record the exact APK SHA-256, signer-certificate SHA-256, merged-manifest SHA-256, commit and run ID. Do not use an APK from a different commit or substitute a locally rebuilt APK without recording new hashes.

**This artifact is compile/install verification only.** Its backend configuration is intentionally empty, so it can check package installation, Android permission prompts, app startup and device metadata. It cannot pair, authenticate to Rub Minds or create a cloud-connected live stream. Do not treat installing it as passing the end-to-end stream test. A live stream requires a separately built APK with an approved isolated-staging HTTPS URL and publishable/anon key, after its backend migration and function have been deliberately deployed to staging. Never embed a service-role key. Production Supabase and Vercel remain out of scope.

The APK is debug-signed and is not a production release. The merged-manifest audit must pass; the final merged manifest currently uses a narrow permission allowlist and exact exported-component allowlist. The current source gate validates the final merged APK manifest, not only the app's source manifest.

## Required setup

1. Use two devices. The TECNO KL4 is the capture source. Open the Backroom Phone Frame on a separate Windows laptop or another device.
2. Install the hash-matched CI compile-verification APK only for package/startup/OS-permission checks. For live pairing and streaming, use a separate staging-configured build as described above; do not point a test build at production.
3. Record actual handset values from the running app: Android release, SDK, ABI, build/display/incremental identifiers, display dimensions and density. Do not infer ABI or QPR2 support from the model name.
4. Use an isolated staging Rub Minds project and a dedicated test group/account. Do not apply this work's migrations or deploy functions to production.
5. Confirm package name, signer digest and app grant on the phone before proceeding to live streaming.

## Live app window and video

| Check | Action | Pass condition |
|---|---|---|
| App selection | Select a locally approved app in the companion | Package and signer match the saved local grant |
| Android chooser | Start sharing and inspect Android's system picker | The intended single-app window is selectable; cancel if the firmware offers only full-display sharing |
| Consent | Confirm the intended app window in MediaProjection | Android's system consent is shown and sharing starts only after approval |
| Video | Observe the Phone Frame on the second device | Live video corresponds to the selected real app window |
| Hidden source | Send the app to background or open Backroom on the phone itself | Android visibility is reported; Phone Frame marks source hidden and disables input |
| Resume | Return the selected app to foreground | Visibility and video recover without a stale first-frame event overriding hidden state |
| App switch | Switch to a different app while Accessibility monitoring is enabled | The session stops when a different foreground package is positively identified |
| Projection revoke | Stop sharing from Android system UI | The companion closes the stream and the Phone Frame reports loss |
| Network loss | Interrupt network connectivity long enough to exceed the bounded heartbeat grace | The phone ends the session; no stale session remains active |
| Stop/restart | Stop locally and remotely, then start a new session | Both stop routes clean up; a new session does not inherit old peer or request state |
| Process recreation | Force-stop/restart the companion while a session is active | MediaProjection, WebRTC, touch and remote-keyboard grants are not restored; a new Android system consent and local re-arm are required |

**Compatibility boundary:** app-window sharing was introduced with Android 14 QPR2. API 34 alone does not prove that an OEM build exposes the app-only picker. The companion cannot independently inspect which picker target the phone user selected. If the intended app-only target is not offered, cancel instead of sharing the entire phone.

## Touch control

1. Enable Android Accessibility for Rub Minds only after reviewing the on-phone service description.
2. Start a view session with the intended app visible. Separately arm remote touch on the phone for 15 minutes.
3. On the laptop, test tap, swipe and long-press on safe, reversible UI controls. Each gesture must carry a unique UUID and return an explicit Android completion/rejection acknowledgement.
4. Confirm input is rejected when the app/window/session changes, the signer grant no longer matches, the source becomes hidden, or local consent expires.
5. Tap **Disarm remote touch now** on the phone. The video must continue in view-only mode while the Phone Frame immediately loses touch capability.
6. Disable or interrupt Accessibility. View-only capture may continue; touch must be revoked.
7. Confirm local and remote stop, projection revocation, device revocation and session expiry all clear the touch grant.

Never use this test on payments, purchases, sending messages or other irreversible actions.

## Phone keyboard and remote text entry

The Android app-window stream does not include the OS keyboard surface. The input path is instead a dedicated text composer in the Backroom Phone Frame connected to the phone's **Rub Minds keyboard** (an Android IME). The user can also type locally using the selected Rub Minds keyboard. This is separate from tap/swipe control and requires a separate local consent.

1. On the phone, open Android Settings and enable **Rub Minds draft keyboard**.
2. Select **Rub Minds keyboard** as the active input method using Android's keyboard picker.
3. Open the companion's stream setup screen. Confirm it reports that Rub Minds keyboard is selected.
4. Tap **Allow Backroom typing for 15 minutes** and approve the explicit on-phone confirmation. If the keyboard is not enabled and selected, the companion must direct the user to Android Settings/picker rather than pretending typing is available.
5. Return to the selected app while keeping it visible. Focus an ordinary, non-sensitive text field on the phone.
6. On the laptop's Phone Frame, enter a short unique test string in **Type into the focused phone field** and press **Insert text on phone**.
7. Confirm the exact string appears in the focused phone field and the laptop receives the matching `remote_text_ack`. The status must say that text was inserted and nothing was submitted.
8. Verify local typing using the selected Rub Minds keyboard as well (letters, digits, punctuation, shift, space, delete and clear). The keyboard does not expose an Enter/Send action.
9. Repeat with a multiline text field. Line breaks may be inserted only when Android reports a multiline editor. Test an ordinary numeric field and phone-number field.
10. Confirm password/credential fields, unsupported date/time editors, unapproved packages, stale session/package bindings, missing local permission and invalid/replayed requests are rejected.
11. Disarm remote typing using **Disarm remote typing now**. The current video may continue, but remote text insertion must be rejected. Stop the stream and verify the grant is revoked. Kill/restart the companion process and confirm the process-local consent does not survive; re-arm locally before another remote insertion.

### Keyboard safety contract

- Remote typing requires the phone user's explicit local 15-minute grant and the Rub Minds IME to be both enabled and selected in Android.
- The phone IME rechecks the live editor package/input type and the currently installed signing certificate against the app's local grant.
- Text is inserted with `InputConnection.commitText` only. The feature does not read existing field content, retrieve text before/after the cursor, invoke an editor action, inject Enter, submit a form or send a message.
- Password fields and unsupported/sensitive editor types are denied. Multiline characters are limited to multiline editors. Maximum request size is 4,000 characters.
- Session/package binding, bounded replay tracking and a per-request acknowledgement prevent a stale or replayed request from being reported as a fresh insertion.
- If the data channel closes before an acknowledgement, the UI explicitly warns that insertion may already have occurred. Inspect the phone field before retrying; an automatic retry could duplicate text.
- This is focused-field text insertion, not accessibility field discovery, drag-select targeting, editor readback or a general-purpose remote keyboard takeover.

## Evidence record

Record one row per test, with PASS/FAIL/NOT RUN and supporting evidence.

| Field | Recorded value |
|---|---|
| Test date/operator | |
| Handset model and Android release | |
| SDK / ABI / build display / incremental | |
| Display dimensions and density | |
| Installed APK SHA-256 | |
| Installed signer SHA-256 | |
| Merged-manifest SHA-256 | |
| Staging project and group ID (non-secret) | |
| App package and signer digest tested | |
| QPR2 app-window picker offers single app | |
| WebRTC first-frame and stability | |
| Tap / swipe / long-press acknowledgements | |
| Local touch disarm while video continues | |
| App switch / projection revoke / network loss | |
| Rub Minds IME enabled and selected | |
| Local remote-typing consent and revocation | |
| Ordinary / numeric / phone / multiline insertion | |
| Password / stale-session / replay rejection | |
| Local and remote stop/restart | |
| Notes, screenshots and log references | |

## Release boundary

Do not mark physical acceptance complete from source inspection, unit tests or a successful APK build. Do not apply the migration, deploy the Edge Function, or modify production Vercel/Supabase as part of this acceptance. Keep the PR draft until the handset matrix and a separately approved staging test pass.

Android guest virtualization remains a separate gate: this implementation mirrors a real installed app. It does not create an isolated guest process/data container or render a guest-only virtual display.
