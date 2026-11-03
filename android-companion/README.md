# Rub Minds Android Companion — cloud device foundation

This standalone Android app is the native endpoint for the Backroom device architecture. It connects to the Rub Minds Supabase Edge Function over outbound HTTPS. It does **not** run an HTTP server, open a localhost port, expose an ADB bridge, or require the web app to connect to the phone.

## Implemented in this slice

- Discovers launcher-visible apps using a narrowly scoped Android package-visibility query and labels apps installed on external SD storage when Android reports `ApplicationInfo.FLAG_EXTERNAL_STORAGE`. This is not a promise to enumerate every installed or work-profile package.
- Lets the user choose app entries locally and stores the current signing-certificate fingerprint for each selection.
- Creates a random 256-bit device credential on pairing and encrypts it with a non-exportable Android Keystore AES-GCM key.
- Redeems a one-use, five-minute pairing code through the Rub Minds cloud. The server stores only SHA-256 digests of pairing codes and device credentials.
- Keeps the device pending until the Rub Minds group owner approves it.
- Syncs only selected app metadata (package name, display label, signer fingerprint, version, and the separate draft-keyboard flag) after approval.
- Uses HTTPS only, disables cleartext traffic and redirects, and sends the device bearer only in the Authorization header.
- The optional input method remains a separate, user-controlled draft-only feature. It never presses Enter or submits a form.
- A provider-neutral guest-runtime contract and acceptance gate now define what a future isolated app engine must prove. This is not a bundled virtualization engine and does not enable guest app launch or screen streaming.

## Build configuration

Requirements: JDK 17, Android SDK Platform 35, Android Gradle Plugin 8.8.2 and Gradle 8.10.2.

Provide the Supabase project URL and **publishable/anon key only** at build time (never a service-role key):

```sh
gradle -PSUPABASE_URL=https://YOUR_PROJECT.supabase.co -PSUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY :app:testDebugUnitTest :app:auditDebugGuestHostManifest :app:assembleDebug
```

You can also set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` in the build environment. Values are generated into `BuildConfig` and are not committed to this repository. The URL is validated at runtime as an HTTPS Supabase project endpoint.

## Merged-manifest build gate

Every debug/release APK or AAB build runs a Gradle audit against the **actual merged manifest**. It rejects any host permission beyond `INTERNET`, any exported component beyond the exact launcher, OS-bound draft keyboard and OS-bound touch accessibility service, duplicate declarations, missing explicit `android:exported` values, or changed launcher/input-method/accessibility-service intent filters. The task writes the merged-manifest SHA-256 and approved component/permission inventory to `app/build/reports/guest-host-manifest/`. A future engine dependency must pass this same gate before an APK can be produced.

Run the audit directly with `gradle :app:auditDebugGuestHostManifest`, or let `:app:assembleDebug` run it automatically.

## Pairing flow

1. In the Rub Minds Backroom web page, select a group and create a one-use Android pairing code.
2. Open Rub Minds Companion on the phone and paste the code.
3. The phone creates a random device token, stores it encrypted with Android Keystore, and claims the code over HTTPS.
4. The web UI shows the device as pending. The group owner must approve it.
5. Tap **Check approval** in the phone app. When approved, selected app metadata is synced to that group.
6. The owner can revoke the device from Backroom. The next device status check detects revocation and clears the local bearer credential.

The phone keeps the raw device credential locally; the database stores its digest only. No service-role key or AI/provider credential is embedded in the APK.

## Physical-device acceptance plan

Use [the Android live-stream acceptance matrix](../docs/BACKROOM_ANDROID_LIVE_STREAM_ACCEPTANCE.md) for MediaProjection, WebRTC, touch and phone-keyboard acceptance on the handset. Use [the Android guest runtime acceptance matrix](../docs/BACKROOM_ANDROID_GUEST_RUNTIME_ACCEPTANCE.md) separately for virtualization-provider admission and guest-only frame/data-isolation checks. The target device's API level, ABI and display geometry must be read from the actual handset during the test.

## Guest runtime integration gate

The companion currently has **no app virtualization provider**. The code under `app/src/main/java/app/rubminds/companion/guest/` defines the future integration boundary only. It deliberately has no BlackBox, VirtualApp or NewBlackbox dependency.

A provider must pass `GuestRuntimeAdmissionPolicy` and a physical-device acceptance record for the same engine version, signed release-artifact SHA-256, merged-manifest SHA-256 and device profile before it can be advertised as ready. In particular, the final merged host APK manifest must be reviewed; a library's manifest alone is not sufficient. The only admitted exported host components are exactly one instance of the exact existing launcher entry point and exactly one OS-bound draft keyboard; all other engine-owned components must remain non-exported unless separately reviewed and explicitly allowlisted. The only currently allowed host `<uses-permission>` is `android.permission.INTERNET`; any additional permission requires an explicit policy change.

The contract requires true per-app guest data isolation, guest-only frames, session-bound touch and accessibility targets, empty-field-only draft insertion, a session/selection-bound one-use native approval receipt and emergency stop. It rejects whole-device screenshots as guest frames and rejects Enter/Send. A selection lease is consumed before writing; failed or ambiguous writes require a fresh selection. The included instance/container registry is process-local helper code; a production provider must persist this mapping across process death. The receipt constructor is private and the factory is internal; a provider must issue a receipt only after its native confirmation dialog succeeds. The receipt is bound to the exact draft request ID and text digest, so changing the request ID or any text after approval invalidates it. No live provider or native approval screen is wired yet. A complete provider must still be implemented and tested on a physical phone.

## Explicit capability boundaries

This slice supports app discovery and selected-app inventory, plus an optional user-consented **live mirror of a real foreground app** on Android 14+. The user selects a locally approved app, approves Android's MediaProjection picker, and returns that app to the foreground. Backroom negotiates a WebRTC video session through the device-authenticated command queue. When Accessibility is separately enabled and touch is locally armed for 15 minutes, Backroom may send taps, swipes and long presses; every gesture is rechecked against the session, selected package, signer grant and current app window. The Phone Frame also supports source-level drag-select targeting of one exact editable composer and local discovery/revalidation of one unique nearby Send control. Those Send checks return only a hashed target identity and status; they do not click or submit. Draft insertion still uses the separate locally approved IME. The native-wake path is separate: the device-bearer command poller recognizes only the strict native_wake_trigger envelope and posts a structured ACK. Its group-wake producer is still missing, so no current group-coordination path queues such a command. This is remote interaction with the real installed app, not a virtualized copy or isolated guest process.

`MANAGE_EXTERNAL_STORAGE` is deliberately not requested. It grants broad access to shared storage, not another app's private sandbox (`/data/user/0/<package>` or another app's `Android/data` directory). Existing private logins and app databases cannot be copied by an ordinary app. A future virtualization engine must create a fresh, isolated data container and pass app-specific compatibility tests; the user signs into that instance separately.

Package inventory is restricted to launchable apps visible under the declared `<queries>` filter. A broader all-packages declaration is not included. The external-storage label is based on Android's installed-package metadata; this app does not scan removable media for uninstalled APK files. Work-profile and external-storage app visibility depends on Android profile, package visibility, and OEM behavior.

## Virtualization engine decision

See [`docs/architecture/backroom-app-execution-engine.md`](../docs/architecture/backroom-app-execution-engine.md) for the explicit proof-of-concept gate and current engine review. NewBlackbox was re-audited and is rejected unchanged: its Bcore source manifest has 323 permission entries (249 unique), with broad host privileges. No virtualization library has been integrated.

## Verification status — 2026-10-31

**Native build and automated tests: passed in an isolated Linux Android SDK 35 runner.**

- JDK 17 / Gradle 8.10.2 / Android Gradle Plugin build completed successfully with `:app:testDebugUnitTest :app:auditDebugGuestHostManifest :app:assembleDebug`.
- Kotlin/JUnit: **60 tests, 0 failures, 0 errors, 0 skipped**.
- Android manifest/resource-policy Node suite: **27/27 passed**.
- Cross-layer Phone Frame, Edge Function, Android touch-policy, SDP protocol and private Realtime suite: **50/50 passed**.
- Combined automated verification: **137 passed, 0 failed**.
- The final merged-manifest audit passed. SHA-256: `029cd32a4f972d980c0e9d4ce5bf7d2e9bce2b5921fa992ab51315448963a2d0`. It contains 5 declared permissions and 4 explicitly exported components.
- Debug APK assembled and verified with `apksigner`. Size: 49,967,179 bytes. SHA-256: `2cc2ba30789ff111ee49acf779871298023d0a28378212ecff7b1f4a4eee40f5`. Debug signer certificate SHA-256: `6765d5a3cbed165ed9b18f45f5742bf313966c4c8cfb0106f2f94d0e75deced0`.
- This compile-verification APK was built with empty `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` BuildConfig values. It cannot pair with a backend. Build a separate APK with an approved staging URL and publishable key before remote stream/keyboard acceptance; record that build's new artifact, signer and manifest hashes. Never put a service-role/secret key in the APK.

**Not yet accepted:** no physical Android handset/ADB device was attached to the remote runner. The TECNO KL4 still needs APK installation, confirmation of the Android 14 QPR2 app-window picker, pairing against an explicitly approved staging backend, WebRTC video, real tap/swipe/long-press, local disarm, app-switch and projection/network revocation checks, and the phone-keyboard acceptance path (enable/select Rub Minds IME, arm locally, insert into a focused ordinary field, receive ACK, test rejection and revoke). Follow [the live-stream acceptance matrix](../docs/BACKROOM_ANDROID_LIVE_STREAM_ACCEPTANCE.md). A debug APK build is not a production release signature.

The GitHub Actions jobs on this branch continue to terminate before runner allocation (`runner_id=0`, no steps executed); that is a GitHub runner-availability failure, not a test result. The checks above were executed directly in the isolated Android SDK runner against the PR source. The migration and Edge Function remain committed source only: they have **not** been applied or deployed. Production Supabase and production Vercel were not changed.

## Local app launch (2026-10-31)

The companion shows **Open on this phone** next to discovered applications. This is an explicit local Android action only. The selected app must first be saved in the device-local allowlist, and its Android signing certificate must still match. The companion asks for a local confirmation and revalidates the saved grant and signer after confirmation. It then uses Android's normal launcher intent. It does not send a cloud command or transmit a screen. An app that is not installed or visible under the Android user profile cannot be opened. Remote app execution and virtualization remain separate, unimplemented capabilities.

The local Open button is enabled only for a persisted matching-signature grant. Pressing **Save and sync selected apps** redraws the app rows immediately so newly saved apps become openable and deselected apps lose their Open action without requiring a restart.


## OS-isolated Work Profile (local handoff, not Phone Frame virtualization)

The companion includes an **optional Android managed Work Profile** path. This is a real Android-managed user/profile boundary: packages installed in the Work Profile have profile-scoped app data, accounts and logins separate from the personal profile. It does not clone the personal app's private data.

Setup is user-initiated:
1. Tap **Set up isolated Work Profile** and review the explanation.
2. Continue into Android's own managed-profile provisioning UI. Android/device policy may disallow provisioning; the companion reports that state and does not bypass it.
3. During provisioning, Android installs the same Rub Minds companion as the profile owner in the new Work Profile. Its DPC receiver stores a per-profile copy of a one-use bridge secret in that profile's Android Keystore and allowlists only the Rub Minds companion package for cross-profile communication.
4. Return to the personal profile and use **Allow secure Work Profile handoff**. Android's own consent screen controls the INTERACT_ACROSS_PROFILES grant.
5. Install the desired app separately inside the Work Profile (for example through the Work Profile's app store), open Rub Minds Companion there, and separately select/save that app. Sign into it again; nothing is copied from the personal profile.
6. In the personal profile, **Open in Work Profile** sends one short-lived HMAC-SHA256-authenticated request to the companion in the single managed profile. The target profile consumes the nonce, independently checks the app's installed signing certificate and its profile-local saved grant, then opens the app locally.

The bridge secret is encrypted independently with Android Keystore in each profile. The handoff is time-bounded, nonce-protected, signer-bound and local-only. The target refuses missing/invalid secrets, replayed/expired requests, multiple target profiles, missing apps, signer changes and apps not explicitly approved inside the Work Profile. The one-use nonce ledger retains every still-valid entry and fails closed at its storage cap rather than evicting a live replay guard.

**Important boundary:** this is genuine OS-managed data separation and a local cross-profile app-launch bridge. It does **not** create an Android VirtualDevice, guest virtual display, in-frame app renderer, screen stream, remote touch driver, guest accessibility tree or drag-to-select insertion. The Phone Frame must continue to report guest app execution as unavailable. A Work Profile app opens as an ordinary Android Activity in the Work Profile, outside the Backroom canvas. The feature must not be described as a virtualized app running inside Backroom.

The only additional host permission is **android.permission.INTERACT_ACROSS_PROFILES**. It is meaningful only when the DPC allowlists the package and the user grants the OS consent. The merged-manifest gate now permits only this permission plus INTERNET, and exactly three exported components: the launcher activity, the BIND_INPUT_METHOD draft keyboard and the exact BIND_DEVICE_ADMIN Work Profile receiver. No accessibility service, all-files access, package-wide visibility, overlay, install permission, ADB listener or cloud-issued app launch is introduced.

Android references:
- [Managed profile provisioning](https://developer.android.com/reference/android/app/admin/DevicePolicyManager#ACTION_PROVISION_MANAGED_PROFILE)
- [Device admin provisioning extras](https://developer.android.com/reference/android/app/admin/DevicePolicyManager#EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE)
- [Cross-profile app access](https://developer.android.com/reference/android/content/pm/CrossProfileApps)
- [DPC cross-profile package allowlist](https://developer.android.com/reference/android/app/admin/DevicePolicyManager#setCrossProfilePackages(android.content.ComponentName,java.util.Set))

## Verification boundary for Work Profile

- The command MAC/expiry/replay helper has JUnit tests for valid, tampered, expired, future-dated, wrong-secret and malformed requests.
- Source-policy tests cover the DPC receiver/export allowlist, only the approved profile permission, HMAC command path, local signer recheck and profile-local grant.
- The final merged-manifest audit includes the DPC receiver metadata and provisioning filters.
- **Not yet verified here:** Android Gradle/JUnit execution, actual DPC provisioning on the TECNO KL4, system consent, cross-profile launch, app availability in the profile, or removal/recovery behavior. Those remain physical-device acceptance steps. Work Profile success does not make the GuestRuntimeProvider READY and does not satisfy live Phone Frame rendering/touch acceptance.


## Android VirtualDevice capability probe (read-only)

The companion now checks whether the handset exposes Android's VirtualDeviceManager service and the secondary-display activity feature. This is the platform direction for a real app-streaming virtual display, but availability is OEM-configured: Android may return no service when the firmware has not enabled config_enableVirtualDeviceManager.

The probe does not create a virtual device or request CREATE_VIRTUAL_DEVICE. The creation API is restricted to system apps with specific roles, and the request requires a Companion Device Manager association ID. An ordinary side-loaded companion cannot treat a visible service as authority to create or control a guest device. The public SDK surface used here only checks Android API level, the secondary-display feature, service availability and the count of visible existing virtual devices.

The UI reports one of four states: Android below API 34; no secondary-display feature; VirtualDeviceManager not enabled by firmware; or platform service present but OEM/system-role authorization still required. A positive service probe is not a working guest runtime.

The Work Profile bridge remains a distinct OS-managed data-isolation and local launch option. It does not provide a virtual display or Phone Frame rendering. Neither capability state makes GuestRuntimeProvider READY; guest-only frames, touch, accessibility targeting, safe draft insertion, Emergency Stop and physical acceptance remain mandatory.

Platform references:
- https://developer.android.com/reference/android/companion/virtual/VirtualDeviceManager
- https://developer.android.com/reference/android/content/pm/PackageManager#FEATURE_ACTIVITIES_ON_SECONDARY_DISPLAYS
- https://android.googlesource.com/platform/frameworks/base/+/refs/heads/master/core/java/android/companion/virtual/VirtualDeviceManager.java


## Live Android app mirror and touch (2026-10-31)

The companion now includes a foreground MediaProjection + WebRTC sender and a Backroom Phone Frame control surface. It does not join Supabase Realtime as a fake user: the phone authenticates each poll/answer/ack with its enrolled device bearer; human users use their real Rub Minds JWT for group authorization; the server publishes Android SDP and permission events to a room-scoped private topic (`backroom-android:<device-id>:<room-id>`). This prevents a member of one group from receiving session signaling for another group bound to the same phone. Commands are session- and room-bound, leased for 60 seconds and expired after two minutes. The database permits only one active screen session per physical device; stale and duplicate sessions are retired before the uniqueness constraint is installed. Old queue rows are pruned after seven days.

View-only streaming does not require Accessibility. Accessibility is a separate OS permission. When enabled, it checks the current active window and dispatches touch gestures only to the locally selected app whose signer still matches the saved app grant. Remote touch must also be explicitly armed by the user on the phone for up to 15 minutes. App/window switches, projection revocation, stop commands, device revocation or peer failure close the session. No accessibility tree or app text is sent to the cloud.

Android app-window sharing was introduced in Android 14 QPR2; device/OEM rollout can vary. The Android screen-sharing picker can offer one app window or the entire display. The companion cannot independently inspect Android's selected capture target, so the user must choose the intended app window; if only full-display sharing is offered, cancel rather than exposing the whole phone. The setup screen displays the OS build identifiers to help verify device support. WebRTC currently uses public STUN servers only, so restrictive NAT/firewall networks may not connect. No TURN relay is configured.

**Still not delivered:** isolated/virtual Android guest instances, separate app-private data, guest-only virtual display rendering, production-enabled/physically accepted native Send, the trusted host-side producer and result reconciliation for group-to-device native wake, native Android Off / On / Auto wake, or a production Emergency Stop for an isolated guest. The Android device-side native-wake queue consumer, local consent/seal and Accessibility/IME Send path are present in source, but the upstream group wake producer is not connected and physical handset acceptance has not passed. Source-level composer discovery, drag-select binding and Send-control discovery/revalidation are also not physical-device accepted. The remote text-to-IME bridge remains unverified on a physical handset. The current stream is a mirror of an ordinary app installation and must not be labelled virtualization.

The earlier baseline command protocol/touch policy and Android build checks were recorded as passing in an isolated Android SDK 35 runner (50/50 cross-layer tests, 60/60 baseline JUnit tests, merged-manifest audit and signed debug APK). That baseline predates the current native-wake queue/ACK work and does not certify the latest source. The newer native-wake Kotlin inventory is 38 policy cases (17 consent/journal + 11 handoff + 8 Send-control + 2 binding-generation); the Android native-wake source, Edge protocol and Edge endpoint suites contain 15, 13 and 30 Node tests respectively. Native Send insertion and final click are bound to one uninterrupted local generation so session stop, app rebind, composer clear or a new drag invalidates queued work. Consent grants, revocations and one-shot reservations now serialize on one process-wide lock shared by all store instances, avoiding instance-monitor races around SharedPreferences. These newer suites have not executed on the latest PR head: GitHub Actions jobs fail before exposing runner steps or logs, and no current APK build is verified. No live migration or Edge Function deployment is implied by committed source.


**Viewing topology:** the phone is the capture source and must keep the selected app window foreground. Open the Backroom Phone Frame control page on a separate device (for example a Windows laptop). Opening the control page on the same phone causes the selected app window to become hidden; Android pauses that app-window capture and Backroom shows a hidden-source state. This path is not an on-device overlay or same-phone virtual display.

The Android stream setup screen also exposes **Disarm remote touch now**. It clears the local 15-minute gate and clears the service's active touch grant without stopping the view-only screen stream.

Platform note: Android's official documentation states that app-window sharing was introduced in Android 14 QPR2. The presence of API level 34 alone does not prove that a particular Android 14 firmware has received the QPR2 user-facing picker feature. Confirm that the device chooser exposes the intended app window before proceeding; cancel if it only offers full display.

## Remote typing into a focused phone app field

The app mirror's Phone Frame includes a **Type into the focused phone field** composer. On the phone, enable **Rub Minds keyboard** in Android Settings, select it in the input-method picker, then open Backroom app streaming and confirm **Allow Backroom typing for 15 minutes**. Keep the selected app visible and focus an ordinary text field in it. Text typed in the Backroom composer is committed by the Rub Minds IME into that focused field.

Remote typing is a separate local permission from touch. It is session/package/signer-bound, requires the app's local draft-insertion grant, supports ordinary text, numeric and phone editors, rejects password and unsupported date/time fields, and expires after 15 minutes or process/service shutdown. It uses InputConnection.commitText only: no editor text is read, no Enter key is sent and no form/message is submitted. Multiline text is accepted only by multiline editors. Each request is acknowledged and protected against replay.

### Native wake: local composer read-back and queue boundary

The separate `submitCanonicalWake` routine is not part of ordinary `remote_text`. It is invoked only by the device command dispatcher after a separately queued native_wake_trigger passes the Android handoff policy. When called, Android reads the selected composer locally to verify that it is empty before the one-shot seal, contains exactly the fixed event-bound `@RMconnects` trigger after IME insertion, and clears after the Send action. These narrowly scoped reads remain inside the phone's Accessibility/IME processes: composer values, accessibility labels/tree, group-message bodies and conversation history are not returned in device acknowledgements or uploaded to Rub Minds.

The Android consumer is connected to the existing device-authenticated android/commands poll and android/ack endpoints, but the trusted host-side forwarder from the group durable wake queue has not been implemented. The group coordinator cannot yet create the device command that would invoke this path. The separate device/app/signer-bound consent checkbox stores local consent only; saving it does not activate remote sending. Native Android Off / On / Auto and autonomous phone participation therefore remain unavailable. This source path is not evidence of a successful current build or physical-device Send acceptance.

Android app-window sharing excludes system UI, so the phone's soft-keyboard surface is not expected to be visible in the video preview. The Backroom composer is the remote text-entry control; the phone's selected keyboard remains available for local typing. The feature is implemented in source but still requires the exact APK build and physical-device acceptance described in the guest-runtime acceptance document.
