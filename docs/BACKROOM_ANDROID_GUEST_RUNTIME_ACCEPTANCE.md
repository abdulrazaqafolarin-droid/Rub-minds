# Backroom Android guest runtime acceptance matrix

Status: **contract and admission policy implemented; no virtualization provider selected or integrated**.

This document is the execution gate for a separate Android physical-device proof of concept. Passing source tests or a library README does not make an app virtualized. The Phone Frame must show a real app process running in an isolated guest container and must receive frames from that guest only.

## Target device and test boundary

- Initial physical target: TECNO KL4 handset, Android 14 as reported by the device owner.
- Read the actual `Build.VERSION.SDK_INT`, `Build.VERSION.RELEASE`, `Build.SUPPORTED_ABIS`, display density and dimensions on the handset during the test. Do not infer ABI from the model name.
- Use a dedicated test Rub Minds group and a throwaway app/test account.
- Use a dedicated guest-provider build variant/application ID and a dedicated release signing key. Do not install an upstream demo APK or a debug-signed artifact as a production-equivalent test.
- Do not import the host-installed app's private data, cookies, account tokens, databases, login session or shared preferences. Sign into the guest instance separately.
- No Production schema, permission, deployment or feature-flag change is part of this proof.

## Provider decision

The current NewBlackbox candidate is **rejected unchanged**. Its current Bcore manifest contains 323 permission entries (249 unique names), including broad package visibility, all-files access, overlay, location, camera, microphone, contacts, phone/SMS and installation permissions. Its app release build uses the debug signing config and targets SDK 28. The README says JDK 17 while the Gradle modules use Java 21 / NDK 29, and the user guide says root is recommended for full functionality. A new candidate must be audited from source and final merged host manifest before a disposable POC.

No candidate is permitted to add:
- any host `<uses-permission>` beyond the companion's current `android.permission.INTERNET`; any additional permission requires a separate security review and an explicit allowlist change;
- any exported host activity, service, receiver or provider beyond the exact existing launcher activity and OS-bound draft-input-method service; a signature permission is not a generic exception;
- `QUERY_ALL_PACKAGES`, `MANAGE_EXTERNAL_STORAGE`, `SYSTEM_ALERT_WINDOW`, accessibility-service exports, or package-installation host permissions;
- camera, microphone, location, SMS, contacts, call-log, phone-state, calendar, account-management or privileged settings/log permissions;
- an inbound localhost listener or an ADB bridge;
- root requirements or host access to another app's private data.

## Admission requirements

The provider must pass `GuestRuntimeAdmissionPolicy` against the final signed release artifact and final merged APK manifest. Evidence must match the exact engine version, release artifact SHA-256, merged-manifest SHA-256 and handset profile. A document-picked APK must be passed only through the granted `content://` URI; the provider re-parses the actual APK and verifies its package and signing certificate. A manifest edit or rebuild invalidates the old physical-device evidence.

Required capabilities:
- rootless execution;
- fresh per-app data containers and isolated guest processes;
- guest-only frame capture;
- touch input and accessibility-backed field targeting;
- draft-only insertion with no Enter/Send;
- Emergency Stop;
- no private app-data import and no inbound network listener.

## Physical-device test sequence

For each app under test (begin with a simple text editor, then ChatGPT and Claude if installable on the device):

| Check | Action | Pass condition |
|---|---|---|
| Install source | Select an installed package or use Android's document picker for an APK | Package name and signing-certificate SHA-256 are independently re-read from the selected source; no arbitrary filesystem path is accepted |
| Fresh instance | Prepare a guest instance | A newly created, empty data-container ID is returned; private data import is false |
| Separate instance | Prepare a second instance of the same app | It receives a different container ID; no cookies, accounts, database or settings are shared |
| Rootless launch | Launch without root or privileged host permission | The app reaches RUNNING and no root prompt is shown |
| Guest frame | Capture the app | Frame is guest-only, has an increasing sequence and matches the active session and instance; no host status bar, other apps or full-device content is mislabeled as guest |
| Coordinate transform | Tap each corner and centre in the Phone Frame | Touch lands at the corresponding guest-app position across portrait/landscape, density scaling and rotation |
| Touch lifecycle | Perform DOWN, MOVE, UP and CANCEL, including multi-touch | Only active pointer IDs are accepted; stale, duplicate, out-of-order or excess pointers are rejected |
| Text target | Drag over one empty text field | The provider receives the current session/instance/frame sequence and normalized drag rectangle, then returns the actual accessibility field identity and bounds; the drag covers at least 65% of that field |
| Unsafe targets | Try password, read-only, disabled, occupied and unexposed custom controls | Each is rejected without changing app text |
| Draft approval | Request a draft | A native local confirmation is required; the opaque receipt binds the session, selection, exact request ID and SHA-256 of the approved text, is single-use and expires |
| Draft insertion | Confirm one plain-text draft | The exact field is re-resolved, verified empty and written once; read-back equals the full draft; submitted is false |
| Replay | Reuse the old selection ID or approval receipt | Rejected; a new drag and fresh local confirmation are required |
| Fresh drag | Drag to a different field, including an invalid field | Old selection and any pending draft are retired immediately |
| Stop/revoke | Stop the guest or revoke the device/session | Guest process and active pointers stop; no further frame, touch or insertion is accepted |
| Process death | Force-stop the companion/provider and reopen | Data-container ownership is recovered safely; no container is silently shared or re-created over existing data |
| Emergency Stop | Invoke the native emergency stop | All guest processes, touch streams, screen frames and pending draft approvals are terminated |
| Network boundary | Inspect device network listeners and traffic | No inbound local server; only required outbound authenticated service connections are used |

## Evidence to record

The final acceptance record must include:
- engine name and immutable version/commit;
- release APK SHA-256 and final merged-manifest SHA-256;
- licence and source provenance;
- device API, ABI, model profile and display geometry;
- test-run ID, date and test operator;
- each acceptance check with pass/fail, evidence and any app-specific limitation;
- installed APK size, guest startup-to-first-frame latency, memory usage, CPU/battery observations and crash/process-death recovery;
- the final permission and exported-component inventory;
- the generated `app/build/reports/guest-host-manifest/<variant>.txt` report from `:app:auditDebugGuestHostManifest` or the release-variant equivalent, containing the exact merged-manifest SHA-256 and approved component/permission inventory. This digest must match the artifact under test.

The record is represented by `GuestDeviceAcceptanceEvidence`. A result for a different build, merged manifest, declared isolation boundary or handset profile must not set the provider to READY. Missing any of the three guest OS-sandbox/sentinel checks must leave the provider at `DEVICE_POC_REQUIRED`.

## Current implementation boundary

Implemented in this branch:
- provider-neutral install, launch, frame, touch, accessibility-target, draft and stop contracts;
- admission rules for source licence, API/ABI, minimum target SDK, final merged manifest, exported components, permission scope, debug signing and exact artifact/manifest hashes;
- guest-only frame validation and guest/session/frame binding;
- normalized field-target geometry, protected/occupied target rejection and 65% selection coverage;
- UUID-scoped selection/draft IDs, one-use local approval receipts, one-shot selection consumption and no-submit result policy;
- resource bounds for eight guest instances, ten active pointers per session and 1,024 retired selections per session;
- Kotlin/JUnit and Node source-contract regression tests added.

Not implemented or verified:
- no provider implements `GuestRuntimeProvider`;
- no app APK is installed/launched in a guest;
- no guest frame is rendered in the Phone Frame;
- no real guest touch or accessibility query exists;
- no native approval screen issues live guest approval receipts;
- no Android Gradle build, APK install, physical acceptance or provider performance test has passed in this session.

**Do not mark Android virtualized app execution complete until the provider is implemented and every required handset check passes.**


## Provider feasibility re-audit (2026-10-31)

The reviewed alternatives still do not pass admission. BlackBox Reborn's Bcore manifest has 323 permission entries (249 unique); its application manifest requests `QUERY_ALL_PACKAGES` and broad external-storage access, its build targets SDK 28 and signs the release variant with the debug key, and its README license badge conflicts with the Apache-2.0 LICENSE file. TeguFy's BlackBox fork retains the same 323/249 core-manifest permission footprint and broad application-manifest permissions. ZENINXOP/BlackBox did not expose source, build files, a manifest or a license in the repository snapshot reviewed, so its claims are unverified.

AVF/Microdroid is a system VM facility, not an ordinary-app SDK: its APIs are `@SystemApi`, and `MANAGE_VIRTUAL_MACHINE` is declared with restricted `signature|preinstalled|development` protection. The development grant supports controlled adb tests, not production use by a normally installed third-party app. AVF would require a preinstalled/OEM/system-app distribution arrangement.

**No Android guest provider has been selected or integrated.** Keep all candidates blocked until a disposable POC has an audited final merged manifest, consistent licensing, non-debug release signing, API/ABI compatibility and completed physical-device evidence.

## Provider re-audit — 2026-10-31 (current source review)

### VineOS — promising architecture, not admitted

Repository: https://github.com/Hexadecinull/VineOS

The current README describes a full Android-on-Android guest and lists framebuffer rendering and single-touch forwarding as implemented. However, it explicitly lists the first bootable Android 7.1.2 ROM as unfinished; later ROM images remain planned. Its no-root phase has only a Shizuku privilege probe checked off; the proot fallback and AVF backend are still unchecked. The app currently declares storage/media, network, foreground-service/special-use, notifications, wake-lock and vibration permissions, and has an exported Shizuku provider protected by `INTERACT_ACROSS_USERS_FULL`. The project is GPL-3.0. These facts do not prove it can launch a GUI Android guest on the target TECNO device today.

Decision: **research lead only; do not integrate or label as a provider**. It needs a first bootable guest image, a no-root execution path that works on stock Android 14 without ADB/host privileges, manifest/component remediation or an explicit security exception, license review for distribution, and physical proof of guest-only frame + touch + lifecycle + independent writable /data before reconsideration.

### NEXTVM — rejected unchanged

Repository: https://github.com/TanvirHossain2/NEXTVM

The public README identifies the project as alpha and advertises device identity spoofing and anti-detection features. Its current host manifest includes `MANAGE_EXTERNAL_STORAGE`, `QUERY_ALL_PACKAGES`, legacy external storage, `REQUEST_INSTALL_PACKAGES`, boot/foreground-service and additional permissions. That exceeds Backroom's least-privilege host policy and introduces capabilities the Backroom guest does not need.

Decision: **reject unchanged**. Do not import its anti-detection, identity-spoofing or broad host-permission behavior.

### VirtualApp Android 14 forks — rejected unchanged

Repositories:
- https://github.com/ISEKHON/VirtualApp
- https://github.com/f0restw0w/VirtualApp_16

ISEKHON's own README warns that the fork is highly unstable and not recommended for production use. Its core library manifest declares `QUERY_ALL_PACKAGES` plus a large legacy permission footprint including account, location, contacts, SMS/call, storage, camera and other protected/device permissions; its library Gradle config still targets SDK 22 and compiles against SDK 30. The VirtualApp_16 repository is a fork of that same codebase, not independent evidence of a production-ready Android 14 guest runtime.

Decision: **reject unchanged**. A fork's Android 14 claim does not satisfy our final-host-manifest, no-private-data-import, target-SDK, compatibility or physical-acceptance gates.

### Official Android Virtualization Framework — not a GUI guest-app route for this host

The official AVF Java APIs are `@SystemApi` and require restricted `MANAGE_VIRTUAL_MACHINE`; they are not available to ordinary third-party apps. The official Microdroid documentation describes a minimal, headless environment without system server, HALs or GUI, intended for headless/native workloads. That is not an embeddable full Android application desktop for Backroom on a stock TECNO device.

Sources:
- https://android.googlesource.com/platform/packages/modules/Virtualization/+/HEAD/libs/framework-virtualization/README.md
- https://android.googlesource.com/platform/packages/modules/Virtualization/+/HEAD/build/microdroid/README.md

Decision: **do not build the Phone Frame GUI guest on AVF** unless device/OEM distribution privileges and a different graphical guest architecture are explicitly established. It is not an ordinary-app workaround.

### Provider decision

No candidate currently passes admission. Keep `GuestRuntimeAdmissionPolicy` fail-closed and keep the Phone Frame's guest-app execution state unavailable rather than launching the host-installed copy or showing a mock. VineOS is the only new candidate worth a controlled follow-up proof once its bootable ROM and no-root path exist; it is not yet technically ready for integration or target-device testing.


## Additional provider source audit — 2026-10-31

These are source-manifest and build-configuration audits only. Neither candidate has been built, installed, launched or accepted on the TECNO KL4. Neither is an approved dependency.

### f0restw0w/VirtualApp_16 — reject unchanged

Source: https://github.com/f0restw0w/VirtualApp_16

The README explicitly warns that the fork is highly unstable and not recommended for production. It claims Android 14 compatibility and no-root execution, but its published tested configuration is a Xiaomi Redmi / Snapdragon 695 on Android 14, not the target TECNO handset.

The current application manifest declares 14 permission entries, including:
- `QUERY_ALL_PACKAGES` and `MANAGE_EXTERNAL_STORAGE`;
- `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` and `POST_NOTIFICATIONS`;
- foreground-service permissions for camera, location, microphone, media playback, phone call, connected device and media projection.

The manifest also has additional exported entrypoints beyond the launcher: an app-list activity, an installer activity-alias, and `.dev.CmdReceiver` (the latter is exported without an explicit signature permission). The fork targets SDK 33, compiles against SDK 34, and uses Android Gradle Plugin 7.4.2 with legacy Android Support libraries. Its README says Android 14 support is still unstable and lists limitations around Xposed, signature parsing and scoped storage.

The candidate might be useful as an isolated research reference for the Activity-stub / classloader approach, but it is not admitted as a dependency. A future extraction would need to prove that only the required engine core can remain after removing broad package/storage access, the command receiver, installer/deep-link surfaces, unused foreground-service paths and their transitive manifest contributions. Any such extraction is a new derived implementation requiring a separate source, native-code, dependency, license-notice, API-compatibility and physical-device audit; merely deleting manifest lines is not sufficient.

### josskixg/renjana — reject unchanged

Source: https://github.com/josskixg/renjana

The current README describes per-instance containers and non-root execution, but the current host manifest declares 11 permission entries, including:
- `MANAGE_EXTERNAL_STORAGE`, legacy external-storage read/write and `QUERY_ALL_PACKAGES`;
- `REQUEST_INSTALL_PACKAGES` and `SYSTEM_ALERT_WINDOW`;
- special-use foreground service and notification permissions.

The manifest sets `android:usesCleartextTraffic="true"`. It also exports `.core.InstanceLaunchActivity` and `.core.DeepLinkDispatcherActivity` in addition to its launcher. The Gradle configuration targets SDK 34, below the Rub Minds guest-host admission minimum of 35. Its release signing configuration falls back to the debug signing configuration when a release keystore is not supplied. This is not acceptable for a Rub Minds release artifact or the narrowly scoped host-permission model.

The repository's README and problem log describe non-root hooking, per-instance storage paths and compatibility fixes, but those are upstream claims, not verified test evidence for our target device. It is not admitted. No Renjana source or binary is copied into Rub Minds.

### Candidate decision

Neither candidate resolves the stock Android 14 distribution boundary or passes the current Rub Minds admission policy. Do not bundle either unchanged, silently relax the permission/exported-component policy, or label an ordinary launched app as a guest. The next acceptable experiment is a disposable, separately signed proof of concept that extracts only the smallest necessary virtualization core, proves clean per-instance storage and guest-only rendering on the actual handset, and passes the unchanged manifest/admission gates. If no such extraction works without forbidden host privileges, retain the blocked provider status and investigate OEM/preinstalled distribution or a clearly separate live-streaming product mode.


## OS-enforced isolation gate — 2026-10-31

A guest provider must now declare an explicit `GuestIsolationBoundary`:

- `ANDROID_MANAGED_PROFILE`: app runs as a separately provisioned Android user/profile with OS-owned per-package UID and data isolation.
- `PRIVILEGED_VIRTUAL_DEVICE`: app runs on an Android VirtualDevice created by an authorized system/preinstalled role holder.
- `MICRODROID_VM`: guest runs behind the platform VM boundary.
- `SAME_HOST_UID_HOOKS` and `UNVERIFIED`: **always blocked**.

A list of subprocess names, a rewritten `ApplicationInfo.uid`, a virtual filesystem path, ART/Binder hooks or separate directories does not establish an Android OS security boundary. A process that shares the companion's Linux UID must be treated as potentially able to access the companion's private files and other same-UID guest state if an escape or hook bypass occurs.

The admission contract also requires the `GUEST_OS_SANDBOX_ISOLATION` capability. `GuestDeviceAcceptanceEvidence` is cryptographically/build bound to the engine ID, immutable version, declared isolation-boundary enum, device API/ABI/profile, signed release-artifact SHA-256 and merged-manifest SHA-256. Evidence from a different isolation boundary is rejected even when the APK hashes happen to match. Physical evidence must include all of:
- `GUEST_OS_SANDBOX_BOUNDARY_VERIFIED`;
- `GUEST_CANNOT_READ_COMPANION_PRIVATE_DATA`;
- `GUEST_CANNOT_READ_OTHER_GUEST_DATA`.

For a profile/VM provider, record the actual process/user identity and independently test that guest code cannot read a random host-private sentinel or another guest's sentinel. Run the check again after process death/restart. Keep the sentinel values local to the test; never upload them to the cloud.

This deliberately blocks ordinary hook-based VirtualApp/BlackBox/Renjana-style candidates unless a separately reviewed OS-enforced isolation boundary is actually demonstrated. Even after the isolation gate passes, the engine must still prove that its guest surface can be rendered inside the Phone Frame with guest-only frames, correct touch mapping and accessibility-backed targeting. A safe app runtime that only opens a separate Android Activity is not yet a Backroom in-frame guest runtime.


## Managed Work Profile bridge — implementation slice (2026-10-31)

The Android companion now includes an optional, local-only managed Work Profile bridge. This is an **OS-managed app-data separation and launch handoff**, not a complete Backroom guest runtime.

### Current behavior

- Starts Android's ACTION_PROVISION_MANAGED_PROFILE flow only after the user confirms in Rub Minds.
- Declares one Work Profile DeviceAdminReceiver protected by BIND_DEVICE_ADMIN, with an empty device-admin policy set.
- On provisioning completion, the DPC checks profile-owner status, stores a fresh bridge secret in that profile's Android Keystore, and allowlists only the Rub Minds companion package with DevicePolicyManager.setCrossProfilePackages.
- The personal-profile copy requests cross-profile consent through Android's CrossProfileApps system UI. It enables the launch button only when Android reports cross-profile interaction is actually allowed.
- The personal-profile button is a local user action. It creates an HMAC-SHA256 command bound to package name, installed signer digest, timestamp and UUID nonce. Commands expire after 60 seconds; future timestamps beyond five seconds are rejected.
- The Work Profile copy accepts only the explicit handoff action while running as profile owner. It verifies the MAC, validates and retires the nonce, re-reads the target app signer in that profile, checks that profile's local AppGrantStore, and opens the app using that profile's own PackageManager.
- The bridge secret is separately encrypted with Android Keystore in each profile. The nonce ledger keeps every still-valid entry and fails closed at 2,048 entries instead of evicting an unexpired replay guard.
- The target app must already be installed and separately selected/saved inside the Work Profile. Accounts, cookies, logins and private app data are not copied from the personal profile.

### Physical-device acceptance specific to this bridge

| Check | Action | Pass condition |
|---|---|---|
| Provision preflight | Inspect setup on the personal profile | Enabled only when Android reports provisioning is allowed and a system setup activity is available |
| Cancel | Start setup and cancel | No profile-owner status is claimed; pending personal-profile secret is cleared |
| Profile owner | Complete setup and open companion in Work Profile | DPM confirms this companion is profile owner; local DPC status is visible |
| Secret isolation | Compare the two profile stores | Each profile has an independently encrypted secret in its own Android Keystore; no secret is uploaded |
| DPC allowlist | Inspect Work Profile DPC state | setCrossProfilePackages contains only the Rub Minds companion package |
| User consent | Use the handoff action and Android's own consent page | Handoff becomes available only after user consent and DPC/OEM allowlisting |
| Denial | Deny or revoke OS cross-profile access | Launch remains disabled or is rejected before opening an app |
| Missing app | Request a package not installed in Work Profile | Target profile rejects it; personal-profile copy is not used as a fallback |
| Signer mismatch | Install a same-package test app with a different signing certificate | Target profile rejects the request |
| Missing local grant | Leave the app unselected in Work Profile | Launch is rejected until a profile-local grant exists |
| Valid handoff | Approve same-signer app in both profiles and launch from personal profile | Only the Work Profile copy is opened after target-side MAC, signer and grant checks |
| Replay | Replay the exact nonce within 60 seconds | Second launch is rejected |
| Tampering | Change package, signer, time, nonce or MAC | Request is rejected |
| Ledger capacity | Fill the unexpired nonce ledger in a test build | New launches fail closed; live entries are not evicted |
| Profile removal | Remove Work Profile in Android Settings | Parent detects no target profile; no personal-profile fallback occurs |

Do not mark these physical checks passed from source tests. Record actual handset API level, ABI, test date, OS consent results and the exact signed APK/merged-manifest hashes.

### Strict feature boundary

This runs ordinary Android Activities inside a separate Android-managed user/profile. It does **not** create a virtual display, render the other profile's native app inside Backroom, capture guest-only frames, route remote touch, expose a guest accessibility tree, or implement drag-select insertion. It is a valid OS data-isolation bridge, but not the requested in-frame Android guest runtime.

The three Work Profile-specific evidence fields (profile owner confirmed, cross-profile allowlist verified, signer-bound launch verified) are required only for ANDROID_MANAGED_PROFILE descriptors. They do not waive the common guest-frame, touch, accessibility, draft-only and Emergency Stop checks required before GuestRuntimeDecision.READY.


## VirtualDevice firmware capability probe — read-only (2026-10-31)

The companion reads the public VirtualDeviceManager service (API 34+) and PackageManager's secondary-display activity feature. It does not create a virtual device, invoke hidden APIs, request CREATE_VIRTUAL_DEVICE, or infer that the app has the system role needed to create one.

| Check | Evidence | Interpretation |
|---|---|---|
| Android API | Read Build.VERSION.SDK_INT | Below API 34: this VirtualDevice path is unavailable |
| Secondary display feature | PackageManager.FEATURE_ACTIVITIES_ON_SECONDARY_DISPLAYS | Missing feature: do not claim this firmware supports app activities on secondary displays |
| VirtualDeviceManager service | getSystemService(VirtualDeviceManager::class.java) | Null: OEM firmware has not exposed/configured the framework service |
| Visible virtual devices | Public manager.virtualDevices list | A nonzero count means existing devices are visible to this caller; it does not grant creation authority |
| Creation authority | OEM/system-role and Companion Device Manager association review | Requires the platform role and association; the ordinary companion APK must not bypass this boundary |

The status surfaced in the app distinguishes unsupported Android, missing secondary-display feature, missing OEM service and platform-present-but-system-role-required. Record this output on the TECNO KL4 along with its exact API level and firmware build. Do not mark the probe passed on the basis of an emulator or a different phone.

Even when firmware capability is present, Backroom still needs an authorized system/OEM provider that can create/manage the virtual device, install/launch the guest, stream only its virtual display into Phone Frame, map touch and keyboard input, expose guest accessibility targets, and enforce draft-only insertion and Emergency Stop. The Work Profile path does not replace those capabilities and does not qualify as in-frame execution.

References:
- https://developer.android.com/reference/android/companion/virtual/VirtualDeviceManager
- https://developer.android.com/reference/android/content/pm/PackageManager#FEATURE_ACTIVITIES_ON_SECONDARY_DISPLAYS
- https://android.googlesource.com/platform/frameworks/base/+/refs/heads/master/core/java/android/companion/virtual/VirtualDeviceManager.java


## Live Android app mirror — separate from the guest-runtime acceptance gate

A source implementation now offers a MediaProjection/WebRTC mirror of a user-selected, saved app in the Phone Frame. It is the real app process installed in the user's Android profile, not an isolated clone. The optional AccessibilityService is for foreground-window checks and touch dispatch only; the local touch grant expires after 15 minutes. The Android screen picker itself is the capture consent authority and must be used each time.

This mirror does **not** satisfy GuestRuntimeDecision.READY: there is no guest-only virtual display, separate app data, accessibility field targeting, drag-select typing or draft insertion/readback. Do not use the mirror to claim that Android apps run inside the isolated Phone Frame.

Before calling the mirror tested, build/install the exact companion APK, apply the migration and deploy the Edge Function to a disposable staging project, pair/approve the TECNO KL4, select one app window in Android's system picker, validate video negotiation, revoke screen permission, switch away from the app, test taps/swipes with Accessibility off/on, stop from both phone and web, and verify that the server session/queue state closes. Record firmware/API/ABI, app signer and merged-manifest hash. Production stays unchanged until those checks and an explicit rollout decision.
