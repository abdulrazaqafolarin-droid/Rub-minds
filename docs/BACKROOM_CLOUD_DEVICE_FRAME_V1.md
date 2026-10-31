# Backroom cloud Device Frame — implementation slice 1

## Architecture

The web UI communicates with Supabase Edge Functions. Native devices initiate HTTPS requests to the same Edge Function. Neither the web page nor the Android companion opens a local listener or uses a loopback/localhost bridge.

```
Rub Minds group web UI
  -> authenticated Supabase Edge Function (owner actions)
  -> private device registry / selected-app inventory / activity events
  <- HTTPS status and inventory responses
Android companion
  -> outbound HTTPS only
  -> one-use pairing claim with a random per-device token
  -> Android Keystore encrypted local bearer credential
```

## Delivered source

- Owner-scoped one-time pairing creation, five-minute expiry and approval/revocation UI.
- Atomic database claim of a one-use pairing code.
- SHA-256-only persistence for pairing-code and device-token verification.
- Selected launcher-app metadata sync only after owner approval.
- A local credential vault backed by Android Keystore AES-GCM.
- Owner-visible device list, app inventory and group activity entries.
- Unified Device Frame surface selector for phone, desktop and terminal; absent drivers remain explicitly unavailable.
- Automated Node tests for scope/payload shape and no-localhost Android permissions/transport.

## Not delivered / release blockers

- No app virtualization engine or separate app-private data environment.
- No private-data cloning; MANAGE_EXTERNAL_STORAGE cannot grant access to other apps' private sandboxes.
- For the Android cloud Device Frame slice specifically: user-consented MediaProjection/WebRTC streaming of a locally selected real app window and an optional signer/session-bound tap/swipe/long-press path are implemented. The Android project has now **compiled successfully and produced a debug APK** in an isolated Linux Android SDK 35 runner. The build ran :app:testDebugUnitTest (60/60), :app:auditDebugGuestHostManifest and :app:assembleDebug successfully; the manifest audit reported SHA-256 `029cd32a4f972d980c0e9d4ce5bf7d2e9bce2b5921fa992ab51315448963a2d0`. The APK SHA-256 is `2cc2ba30789ff111ee49acf779871298023d0a28378212ecff7b1f4a4eee40f5` (49,967,179 bytes, debug-signed). Android manifest/policy checks passed 27/27 and the adjacent Phone Frame/Edge/Realtime cross-layer suite passed 50/50. **Physical-device acceptance is still pending** because the runner had no attached handset/ADB target.
- There is still no virtual guest-app rendering, isolated app-private data, Phone Frame accessibility field discovery, drag-select target-bound draft executor or guest-only virtual display. The separate Windows desktop companion has a source-level UI Automation targeting path, but native Windows compilation and physical acceptance remain independent release gates.
- The Supabase migration and Edge Function are source-only. They have not been applied or deployed. Do not claim pairing is live until a separately approved staging deployment and live pairing test succeed.

## Release gates

1. Install the verified debug APK on the TECNO KL4 and record the actual Android release/SDK, ABI, build identifiers, installed package signer and merged-manifest digest. The debug APK is for acceptance, not production distribution.
2. Use two devices: keep the selected app visible on the phone and open the Backroom Phone Frame on a separate laptop/device. Confirm the Android 14 QPR2 app-window picker exposes the intended app; cancel if only full-display capture is offered.
3. After a separately approved staging deployment, apply the migration and deploy the Edge Function to an isolated staging project. Verify pairing approval/revocation, private room-scoped SDP, WebRTC video, touch ACKs, local touch disarm while video continues, app-switch handling, projection revoke, network loss and local/remote stop.
4. Keep the Android guest-virtualization provider as a separate project gate. Audit any candidate against the final merged host manifest, release signing, licensing, rootless launch and guest-only frame/touch/isolation acceptance. A real-app mirror is not a virtual guest.
5. Verify the desktop companion's native Windows build and physical UI Automation acceptance independently.
6. Keep production Supabase and Vercel unchanged until staging and physical acceptance are complete.

Production Supabase and the production Vercel deployment have not been modified by this source change.


## Virtualization engine assessment — 2026-10-30

Candidate reviewed: [Black00Z/Blacks-BlackBox](https://github.com/Black00Z/Blacks-BlackBox), Apache-2.0. The repository is a standalone Android application/engine (not a drop-in Android library). Its current README explicitly narrows validation to a work-profile + Instagram priority path, says compatibility is incomplete, and says game support is not included. Its Gradle app uses Java 21, Kotlin, NDK 29, several external dependencies, and its own app identity; our current companion targets Java 17. This is not safe to embed or ship as a universal clone engine without a dependency/licensing review and an ARM64 Android 14 device smoke test.

Decision: keep the virtualization engine behind a future adapter and do not copy its code into this branch yet. First build and test its unmodified demo on the target device; select one non-sensitive test app; verify fresh isolated data, launch/close/restart, profile-bound package identity, media/URI behavior and uninstall cleanup. Do not promise work-profile apps, game/banking apps, Play Integrity, Google sign-in or every OEM until each is tested.

This branch currently implements launcher-visible app inventory only. The false capability flags in `DEVICE_CAPABILITIES_V1` are deliberate: there is no virtual instance, screen or touch driver yet.

For Preview acceptance, set the Edge Function's `BACKROOM_DEVICE_ALLOWED_ORIGINS` to the exact HTTPS Preview origin as well as the production origin. Do not use wildcard origins. The default value intentionally allows production only.

## User-facing route decision — 2026-10-30

The normal `?backroom=1` entry now opens the cloud Device Frame directly. The older paired-local-host simulator is no longer linked from the Backroom navigation. Its source and isolated tests remain in the repository as a prototype, but it is not part of the normal Device Frame route. This is intentional: the phone and desktop runtimes must connect outbound to the cloud, not be controlled through localhost.

The Android inventory labels installed apps as external/internal storage based on Android's `ApplicationInfo.FLAG_EXTERNAL_STORAGE` metadata. That flag is not a reliable claim that a removable SD card is present. It does not browse arbitrary APK files on removable media or request broad file access. Uninstalled APK import is a separate future feature requiring a user-picked document URI and a compatible virtualization engine.

A separate CI job now builds the native Android module with JDK 17 / Gradle 8.10.2 / Android SDK 35 and runs the Kotlin/JUnit policy tests. It uses placeholder public build configuration only; no production secret is passed to CI.


## Virtualization dependency security review — 2026-10-30 (expanded)

The upstream candidate exposes a `Bcore` Android library module, but that does not make it a safe drop-in dependency. The inspected `Bcore/src/main/AndroidManifest.xml` contains 323 `uses-permission` entries. Among its declared permissions are `QUERY_ALL_PACKAGES`, `MANAGE_EXTERNAL_STORAGE`, `SYSTEM_ALERT_WINDOW`, camera, microphone, location, contacts, phone/SMS, account-management, package-installation and other system permissions. Many entries are vendor- or Google-services-specific, obsolete or unavailable to ordinary apps; their presence still creates manifest-merging and runtime-permission review work. Its own app manifest separately requests `QUERY_ALL_PACKAGES`, legacy storage and a Samsung account permission.

The library also uses Java 21 and NDK 29, has native build integration, requires several additional Gradle modules and dependencies (including JitPack and Aliyun Maven repositories), while this companion is intentionally Java 17 and currently has a minimal permission surface. The upstream app's release build configuration signs with the debug signing configuration. The published debug APK is therefore not an acceptable production dependency or trust anchor for Rub Minds.

**Decision: do not import its application module, merge its manifest unchanged, or install its published debug APK as the Rub Minds runtime.** A later virtualization spike may reuse reviewed, separable library code only after:

1. pinning an immutable upstream commit and auditing the complete transitive dependency/license graph;
2. creating a minimal host-specific manifest and testing that core guest launch works without broad permissions (otherwise the missing permission must be justified and consented individually);
3. removing demo/gallery/VPN/device-spoofing features and vendor-specific compatibility code not required by the Rub Minds use case;
4. building and signing a dedicated Rub Minds artifact with a controlled release key;
5. proving guest-app install, launch, isolated data, lifecycle, close and uninstall on the target Android 14 TECNO device; and
6. measuring battery, memory, compatibility and remote-view latency before advertising an in-simulator app experience.

Until those gates pass, the web Device Frame must continue to label Android apps as selected inventory only. It must not render them as running virtual apps or imply that an AI can already see or control their screens.


## Primary Device Frame surface coverage

The authenticated Backroom route opens the cloud Device Frame by default and exposes a separate `Browser runtime` workspace for the existing managed Playwright/Chromium runtime. The Device Frame currently has phone-app inventory, desktop and terminal placeholders; browser remains a peer workspace rather than an in-canvas surface. The browser runtime still requires its paired local host on the same computer. Do not report a single unified four-surface simulator as complete until browser tabs, Android virtual apps, desktop windows and terminals are all rendered as surfaces in the same Device Frame.

## Revocation data handling

The owner-revoke transaction marks the device and room binding revoked, appends the `device_revoked` audit event, and removes the live selected-app catalog. Historical group events remain available; raw screen contents, app-private data and credentials are never stored in this catalog.


## Browser workspace access

After sign-in, Backroom exposes two workspace routes. **Device Frame** is the default route and shows cloud-connected device inventory. **Browser runtime** mounts the existing managed Playwright/Chromium implementation from `src/BackroomSimulatorApp.tsx`. The browser route is selected by `?backroom=1&browser=1`; the group selector preserves this query route when the group changes. The browser host is still paired locally with the computer running Chromium, so this route does not turn that desktop runtime into a phone-hosted/cloud browser and must not be described as a cross-device control connection.


## Desktop drag-select target verification — implementation update

The Windows native companion now resolves the centre of the Backroom drag rectangle through Windows UI Automation. It accepts only a visible, enabled `Edit` or `Document` control with a writable and readable Value pattern, rejects password/protected fields, and requires the field to be empty. The companion captures the selected control's process ID, UIA runtime ID, class, window handle (when exposed) and bounds. It rechecks the same identity and empty value after the native approval dialog, writes directly through that control's UI Automation Value pattern, and reads back the exact value. The draft path does not use a coordinate click or global keyboard injection. The target is consumed before typing so uncertain outcomes cannot be replayed. Apps that do not expose reliable UIA value readback are rejected; the Windows implementation has not yet been physically accepted against the target app matrix.

## Android Phone Frame input-targeting boundary

The Phone Frame can now request a user-consented live mirror of a real Android app window and, separately, request locally armed taps/swipes/long presses. This path uses the actual app installation and actual foreground Android window; it does not create a virtual guest or isolated app-private data. Android Accessibility field discovery in the Phone Frame, drag-select target binding and draft insertion/readback are still **not implemented**. Do not translate phone-frame drag rectangles into text insertion until the guest/app identity, accessibility field identity, current-frame bounds, empty-field status, protected-field rejection, locally confirmed one-use draft permission and exact post-write readback are implemented end to end.

The desktop driver records whether a selected control supports `Value` or `Text` access. `Value` controls use direct ValuePattern insertion; multi-line `Text` controls use the UIA element's focused `send_text` operation after a fresh focus/identity/empty-value check. The UIA `Text` pattern itself is read-only; typing uses the element's focus-bound send_text operation and exact post-write text readback. Both modes reject control characters, protected/read-only/non-empty fields and stale target identities. No Enter/Send is issued.


## Android live app mirror — source implemented, validation pending

The Android companion now has a local setup screen, Android 14+ MediaProjection picker, foreground mediaProjection service, WebRTC video sender, short-lived device-authenticated command queue, and a browser WebRTC receiver mounted in the Phone Frame. The phone is authenticated with its device bearer on outbound HTTPS; the browser is an authenticated Rub Minds group member; the server binds commands and SDP to the active device-room-session tuple. Android signaling uses a separate private Realtime topic containing both device ID and room ID, with server-side membership checks against that exact binding. The phone does not join private Realtime as an invented user.

View-only capture does not require Accessibility. Touch is separate: the user enables the OS AccessibilityService and explicitly arms a 15-minute local grant. A gesture must match the current session, locally selected package, signer-bound app grant, active window and window bounds. App switches or screen-capture revocation stop the stream. No app text/accessibility tree is uploaded.

Limitations remain: app-window sharing was introduced in Android 14 QPR2; API level 34 by itself does not prove the OEM firmware exposes the app-only picker. The Android picker may offer one app window or the entire display; the selected capture target is not independently queryable by the companion, so the user must choose the intended app window and cancel if only full-display sharing is available. The setup screen displays the OS build identifiers to help verify compatibility. WebRTC uses STUN only; no TURN relay is configured. The stream mirrors the ordinary app and is not virtualization. Isolated guest processes/data, virtual display guest-only rendering, field discovery, drag-select typing and draft insertion/readback remain unimplemented. Android Gradle build, Edge Function/migration deployment and physical TECNO KL4 testing are still release gates.


The Android live mirror requires a second viewing device: keep the selected app visible on the Android phone and open the Backroom Phone Frame on the laptop/second device. Android pauses an app-window capture when that app window becomes hidden; the browser shows this state and disables touch until the track resumes.
