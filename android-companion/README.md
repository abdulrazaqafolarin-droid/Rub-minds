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

Use [the Android guest runtime acceptance matrix](../docs/BACKROOM_ANDROID_GUEST_RUNTIME_ACCEPTANCE.md) for the handset POC, app-by-app compatibility checks, exact artifact/manifest evidence, and release gates. The target device's API level, ABI and display geometry must be read from the actual handset during the test.

## Guest runtime integration gate

The companion currently has **no app virtualization provider**. The code under `app/src/main/java/app/rubminds/companion/guest/` defines the future integration boundary only. It deliberately has no BlackBox, VirtualApp or NewBlackbox dependency.

A provider must pass `GuestRuntimeAdmissionPolicy` and a physical-device acceptance record for the same engine version, signed release-artifact SHA-256, merged-manifest SHA-256 and device profile before it can be advertised as ready. In particular, the final merged host APK manifest must be reviewed; a library's manifest alone is not sufficient. The only admitted exported host components are exactly one instance of the exact existing launcher entry point and exactly one OS-bound draft keyboard; all other engine-owned components must remain non-exported unless separately reviewed and explicitly allowlisted. The only currently allowed host `<uses-permission>` is `android.permission.INTERNET`; any additional permission requires an explicit policy change.

The contract requires true per-app guest data isolation, guest-only frames, session-bound touch and accessibility targets, empty-field-only draft insertion, a session/selection-bound one-use native approval receipt and emergency stop. It rejects whole-device screenshots as guest frames and rejects Enter/Send. A selection lease is consumed before writing; failed or ambiguous writes require a fresh selection. The included instance/container registry is process-local helper code; a production provider must persist this mapping across process death. The receipt constructor is private and the factory is internal; a provider must issue a receipt only after its native confirmation dialog succeeds. The receipt is bound to the exact draft request ID and text digest, so changing the request ID or any text after approval invalidates it. No live provider or native approval screen is wired yet. A complete provider must still be implemented and tested on a physical phone.

## Explicit capability boundaries

This slice supports app discovery and selected-app inventory, plus an optional user-consented **live mirror of a real foreground app** on Android 14+. The user selects a locally approved app, approves Android's MediaProjection picker, and returns that app to the foreground. Backroom negotiates a WebRTC video session through the device-authenticated command queue. When Accessibility is separately enabled and touch is locally armed for 15 minutes, Backroom may send taps, swipes and long presses; every gesture is rechecked against the session, selected package, signer grant and current app window. This is remote interaction with the real installed app, not a virtualized copy or isolated guest process.

`MANAGE_EXTERNAL_STORAGE` is deliberately not requested. It grants broad access to shared storage, not another app's private sandbox (`/data/user/0/<package>` or another app's `Android/data` directory). Existing private logins and app databases cannot be copied by an ordinary app. A future virtualization engine must create a fresh, isolated data container and pass app-specific compatibility tests; the user signs into that instance separately.

Package inventory is restricted to launchable apps visible under the declared `<queries>` filter. A broader all-packages declaration is not included. The external-storage label is based on Android's installed-package metadata; this app does not scan removable media for uninstalled APK files. Work-profile and external-storage app visibility depends on Android profile, package visibility, and OEM behavior.

## Virtualization engine decision

See [`docs/architecture/backroom-app-execution-engine.md`](../docs/architecture/backroom-app-execution-engine.md) for the explicit proof-of-concept gate and current engine review. NewBlackbox was re-audited and is rejected unchanged: its Bcore source manifest has 323 permission entries (249 unique), with broad host privileges. No virtualization library has been integrated.

## Verification status

- Repository Node tests statically verify permissions, HTTPS-only transport, lack of inbound localhost listeners, credential handling, and package query scope.
- Kotlin/JUnit tests cover the existing per-app draft-insertion policy and the guest runtime admission/frame/touch/target/one-shot lease safety contract.
- Node source-contract tests verify that no virtualization dependency or broad permission has been added to the companion.
- **Not yet verified here:** Android Gradle compilation, APK installation, WebRTC device-to-browser negotiation, MediaProjection consent on the TECNO KL4, real touch dispatch, cloud function deployment, migration execution, migration application, or pairing against a live backend. A successful Android build and physical-device acceptance are mandatory before release.

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

The companion now includes a foreground MediaProjection + WebRTC sender and a Backroom Phone Frame control surface. It does not join Supabase Realtime as a fake user: the phone authenticates each poll/answer/ack with its enrolled device bearer; human users use their real Rub Minds JWT for group authorization; the server publishes the answer to the private device channel. Commands are session- and room-bound, leased for 15 seconds and expired after two minutes. Old queue rows are pruned after seven days.

View-only streaming does not require Accessibility. Accessibility is a separate OS permission. When enabled, it checks the current active window and dispatches touch gestures only to the locally selected app whose signer still matches the saved app grant. Remote touch must also be explicitly armed by the user on the phone for up to 15 minutes. App/window switches, projection revocation, stop commands, device revocation or peer failure close the session. No accessibility tree or app text is sent to the cloud.

The Android screen-sharing picker can offer one app window or the entire display. The companion cannot independently inspect Android's selected capture target, so the user must choose the intended app window; choosing the whole display will expose the whole display. WebRTC currently uses public STUN servers only, so restrictive NAT/firewall networks may not connect. No TURN relay is configured.

**Still not delivered:** isolated/virtual Android guest instances, separate app-private data, guest-only virtual display rendering, accessibility-backed field discovery in the Phone Frame, drag-select target binding, draft insertion/readback, app-specific keyboard input, or a production Emergency Stop for an isolated guest. The current stream is a mirror of an ordinary app installation and must not be labelled virtualization.

The command protocol and touch policy have Node source-contract regression tests; native :app:testDebugUnitTest, merged-manifest audit and :app:assembleDebug are configured in GitHub Actions. Those commands still need a green run. No live migration or Edge Function deployment is implied by committed source.
