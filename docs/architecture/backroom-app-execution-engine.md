# Backroom app execution engine decision

Status: **decision pending a device-backed proof of concept**. This is an architecture guardrail, not a claim that app virtualization is implemented.

## Product target

Backroom should eventually offer one group-visible Device Frame with four surfaces: Android apps in an isolated phone-shaped space, managed browser sessions/tabs, desktop apps in a desktop window, and terminals in a terminal surface. A human or authorized AI may request launch, close, restart, switch, tap, swipe, type, press keys, or run commands. Every accepted, rejected, and completed action must be attributed to its human/AI actor and appended to the group's durable activity log.

## Android app execution platform boundary — 2026-10-31

A normal third-party Rub Minds companion APK cannot create the Android virtual-device app-streaming environment that would run another installed app in a separate Backroom-owned virtual display with remote input:

- Android's `VirtualDeviceManager#createVirtualDevice` requires restricted `CREATE_VIRTUAL_DEVICE`. AOSP documents that this permission is granted to system apps holding the `COMPANION_DEVICE_APP_STREAMING` role; only preinstalled privileged apps can hold that role.
- Android Virtualization Framework / Microdroid is separate: its APIs are `@SystemApi` and require restricted `MANAGE_VIRTUAL_MACHINE`, unavailable to an ordinary sideloaded app.
- Android 14+ MediaProjection can let a user share one selected app window, but that captures the existing app window; it does not create an isolated guest instance or separate app-private data.
- An AccessibilityService can inspect accessible controls and dispatch gestures only after the user enables it in Android Settings. It is a powerful system-wide capability, not ordinary app access. Its distribution/policy eligibility must be established before remote automation is enabled.

**Decision:** keep the Android guest provider unimplemented and fail closed rather than ship a fake simulator or import an unsafe virtualization engine. A device-owned single-app MediaProjection session may be built as a clearly labelled *live app streaming* mode, but it must not be marketed as isolated virtualization and must have separate consent/input gates. True isolated app streaming with OS virtual input requires OEM/preinstalled privileged-role distribution or a separately audited engine that passes the full Android 14 handset acceptance matrix.

Primary platform references:
- Android app screen sharing / MediaProjection: https://developer.android.com/media/grow/media-projection
- AOSP companion app streaming role: https://source.android.com/docs/core/permissions/app-streaming
- Android Virtualization Framework privilege boundary: https://android.googlesource.com/platform/packages/modules/Virtualization/+/HEAD/libs/framework-virtualization/README.md
- AccessibilityService intended use and capabilities: https://developer.android.com/reference/android/accessibilityservice/AccessibilityService

## Android constraint

The current Android companion only discovers launcher-visible packages and syncs selected metadata through outbound HTTPS. It does not clone package code, copy private app data, render an app inside Backroom, or remotely operate the device. Broad storage access does not grant access to another app's private sandbox. Do not market this slice as a DualSpace equivalent.

## Engine evaluation gate

Before selecting an embedded virtualization library (including the BlackBox candidate), run a throwaway Android proof of concept on a physical device and record:
- supported Android/API levels, ABI and target apps;
- merged manifest permissions, exported components, native libraries and licence;
- install/start/stop/restart behavior and separate per-instance data;
- process death, crashes, notification, WebView, Play Services and login compatibility;
- whether the design complies with Play policies and Android security constraints;
- APK size, memory, startup latency and battery impact.

Reject any approach that requires undisclosed broad permissions, exposes an inbound localhost server, copies private data without a supported mechanism, or presents ordinary external app launches as virtualized apps. Keep the initial cloud protocol outbound-only.

## Initial engine research (not yet adopted)

### ALEX5402/NewBlackbox — researched candidate; reject unchanged

Repository: [ALEX5402/NewBlackbox](https://github.com/ALEX5402/NewBlackbox). The GitHub repository metadata and root `LICENSE` file identify Apache-2.0. Its README claims Android 5–14+, no-root userspace virtualization, ARM64/ARMv7/x86 support, and describes a Bcore core module / AAR-style integration.

The source review found important gaps between that top-level pitch and a safe Rub Minds integration:

- The app and Bcore Gradle modules use Java 21 and NDK 29, despite README build guidance saying JDK 17. The root build targets SDK 35 but sets target SDK 28.
- The current Bcore manifest contains **323 permission entries (249 unique names)**. It includes `QUERY_ALL_PACKAGES`, `MANAGE_EXTERNAL_STORAGE`, `SYSTEM_ALERT_WINDOW`, location, camera, microphone, contacts, phone/SMS, account-management, package-installation and many legacy/vendor permissions. These are permissions in the virtualization engine's host manifest, not just simulated guest-app permissions.
- The release app build is configured with the debug signing key. Do not use the published/demo APK as a Rub Minds trust artifact.
- The user guide says root is recommended for full functionality, although the README overview says no root is required. That discrepancy must be resolved with an unrooted proof of concept on the target handset.

The Apache-2.0 license is clear, and the repository documents a Bcore library module, but the engine is **not approved for integration**. The README's no-root claim conflicts with the user guide's statement that root is recommended for full functionality; the README says Android 5–14+ while the releases page advertises Android 16 work. The source build also uses Java 21/NDK 29 while the README says JDK 17. The app's release build is signed with the debug signing configuration. A separate disposable POC would first need to remove broad host permissions and unused modules, use a dedicated test application ID and release signing key, build against the companion's target SDK, and pass the complete physical-device acceptance matrix. Do not include the upstream code or its AAR in the companion until those gates pass.

### fdavids77/BlackBoxReborn — legal hold pending upstream clarification

Repository: [fdavids77/BlackBoxReborn](https://github.com/fdavids77/BlackBoxReborn). Its README badge and text say GPL-3.0, while GitHub repository metadata and the checked-in root `LICENSE` file identify Apache-2.0. This mismatch makes the intended licensing/provenance unclear. Do not copy, link, distribute or ship its code until the upstream maintainer clarifies the governing license and the full history/dependency graph is audited.

Its README reports Android 14–17 fixes but the listed successful device evidence is limited (Samsung A25 on Android 16 and a Pixel 10 Pro on Android 17), and it documents app-specific gaps such as WhatsApp companion-link handshakes and strong Play Integrity. Those claims need reproducible local testing; they are not a guarantee for this TECNO device.

### Black00Z/Blacks-BlackBox — reject unchanged

Repository: [Black00Z/Blacks-BlackBox](https://github.com/Black00Z/Blacks-BlackBox). Its root LICENSE and GitHub metadata indicate Apache-2.0, but its standalone application is a customized fork with a Java 21 / NDK 29 build, a large third-party dependency set and a broad Bcore permission manifest similar to NewBlackbox. Its README explicitly says compatibility is incomplete and narrows its own validation focus to selected apps / work-profile scenarios. Its release build is configured with debug signing. It is not a safe drop-in runtime.

### Platform virtualization APIs

Android's [Virtualization Framework API documentation](https://android.googlesource.com/platform/packages/modules/Virtualization/+/HEAD/libs/framework-virtualization/README.md) says its Microdroid APIs are system APIs requiring the restricted `MANAGE_VIRTUAL_MACHINE` permission; they are not a general drop-in option for ordinary third-party apps.

**Decision (2026-10-31):** NewBlackbox is rejected unchanged. No engine has been selected or integrated. The Rub Minds companion now contains a provider-neutral guest-runtime admission, frame and target policy contract, but it is not an engine and does not launch or render guest apps. An engine may be admitted only after its final merged host manifest, license, release signature and required capabilities pass static review, followed by matching physical-device acceptance evidence. Do not claim a native app is running inside Backroom until a real isolated guest instance is launched and its guest-only frame is rendered in the Phone Frame on a physical device.

## Provider-neutral guest runtime contract — 2026-10-31

The Android companion now defines a provider boundary in `android-companion/app/src/main/java/app/rubminds/companion/guest/GuestRuntimeContract.kt`. This is policy and data-contract code only; no external virtualization engine is linked.

An engine is blocked unless its reviewed final host manifest declares only the existing `android.permission.INTERNET` host permission and exactly one known launcher activity plus exactly one system-bound input-method service as exported components. Additional permissions and additional exported components are denied by default, even when a component claims signature protection; engine-owned services and providers must remain non-exported unless separately reviewed and explicitly allowlisted. The release artifact must not be debug-signed, its license must be allowlisted, it must not require root or an inbound listener, and it must declare all required capabilities: a fresh per-app data container, process isolation, guest-only frame capture, touch input, accessibility-backed field targeting, draft-only insertion, emergency stop and no private-data import.

The final merged manifest review includes both permission declarations and exported component exposure; a permission-light manifest with an exported unprotected bridge is not acceptable. The companion's Gradle `audit*GuestHostManifest` task reads AGP's `SingleArtifact.MERGED_MANIFEST` and is a dependency of APK/AAB assembly. It fails on permissions beyond `INTERNET`, extra or duplicate exported components, missing explicit export values, and changes to launcher/input-method intent filters. It records the exact merged-manifest SHA-256 and component inventory under `app/build/reports/guest-host-manifest/`; retain that report with the matching APK. Static capability declarations are not sufficient to make the engine ready. `GuestRuntimeAdmissionPolicy` remains at `DEVICE_POC_REQUIRED` until acceptance evidence matches the exact engine version, release artifact SHA-256, merged-manifest SHA-256 and local device profile and all required checks pass.

Frame and target rules are fail-closed:
- A frame must be tagged `GUEST_APP`, belong to the active session and guest instance, have a strictly positive sequence, valid dimensions/MIME type, a bounded payload and a recent capture timestamp. Whole-device capture cannot masquerade as an app frame.
- A text target must be accessibility-backed, enabled, editable, non-password, non-read-only and empty. Its identity and frame sequence must match the active guest instance. Selection and draft request IDs must be RFC 4122 UUIDs; the launcher/export exception is bound to the exact companion application ID and exact component classes.
- The drag rectangle must cover at least 65% of that single field. A selection expires after 60 seconds and cannot cross a guest restart or a newer frame.
- A new drag immediately supersedes the previous selection; invalid drags also retire the old target. A valid selection lease is consumed before a write attempt, so an ambiguous result requires a fresh drag rather than an automatic retry. Each guest session retains at most 1,024 retired selection IDs; at that limit the session must be restarted rather than discarding replay history.
- Touch pointers must follow valid DOWN/MOVE/UP-or-CANCEL lifecycles, remain monotonic in timestamp, and are capped at 10 simultaneous pointers per session. The provider registry is capped at eight concurrent guest instances.
- Each guest instance must have its own fresh data-container ID. The included registry is process-local test/helper code; a production provider must persist that ownership mapping across app-process death and prove it in the acceptance run.
- Draft insertion requires a short-lived opaque receipt issued only after a local native confirmation succeeds, the exact current selection ID, single-line plain text (maximum 4,000 characters), exact read-back and an explicit no-submit result. The install contract accepts the same multi-signer SHA-256 format as the companion's existing signer checker. The receipt is bound to the guest session, selection, exact request ID and SHA-256 of the approved text, and is consumed once. Any post-approval text change invalidates it. A caller cannot provide a `approvedLocally` Boolean or serialize a trusted receipt from the network. Enter/Send is not part of this interface.

The receipt factory is only an internal contract boundary; a real provider must call it exclusively after its native confirmation dialog returns affirmative. No local approval dialog or receipt issuer is wired to a live guest runtime in this slice. This contract creates the integration point for a future provider; it does not yet implement app installation, guest process creation, video capture, touch injection or real accessibility queries. No current Android provider implements `GuestRuntimeProvider`, and no guest frame is available to the Phone Frame.

## Permission UX

Ask only for a permission required by a demonstrated feature, immediately before that feature is enabled. Explain its actual scope and limitations, link to the OS-owned settings page where applicable, and offer “Disagree and exit” or continue without the optional feature. Do not request All Files Access merely because a reference app does: it does not unlock another app's private data. Accessibility and screen-capture capabilities require separate, explicit OS-mediated consent and policy review.

## Delivery stages

1. **Cloud device foundation (current):** pairing, owner approval/revocation, selected app inventory, HTTPS-only device client and group audit events.
2. **Android virtualization spike:** isolated app runtime proof-of-concept and compatibility matrix; no production permission expansion.
3. **Device Frame contract:** unified surface/session/action schema for Android, browser, desktop and terminal; capability grants, actor attribution and replayable audit events.
4. **Execution drivers:** wire the existing managed Playwright/Chromium host into the primary Device Frame, then add an Android virtual-app driver, desktop driver and terminal driver, each with explicit scopes and confirmation rules.
5. **End-to-end acceptance:** group human and AI launch/switch/operate flows; verify revocation, denied actions, restart behavior and complete audit trail.

A stage is complete only when its acceptance tests run successfully; source-only checks are not a substitute for an installed-device test.


## Current primary-frame gap

The current user-facing `BackroomApp` routes signed-in users to the cloud `BackroomDevicesApp` by default. A second authenticated `Browser runtime` workspace mounts the earlier `BackroomSimulatorApp` managed Playwright/Chromium surface. Changing groups inside that browser workspace preserves the `backroom=1&browser=1` route. This restores browser access without discarding the cloud Device Frame. Browser is still a peer workspace, not yet a tab rendered inside the same phone/desktop/terminal Device Frame canvas. The managed browser host remains a same-computer local runtime; it is not an Android localhost bridge and cannot be assumed reachable from a different device.

Likewise, the phone tab currently renders selected-app metadata, not a guest app screenshot or running virtual app. The Android companion reports discovery/inventory only. These are explicit V1 boundaries, not completed app virtualization.


## Second provider audit — 2026-10-31

A second pass checked newer public forks and the platform-supported VM route. None is currently admitted:

- **[BlackBox Reborn](https://github.com/fdavids77/BlackBoxReborn)** advertises API 34–37 compatibility and Apache-2.0 in its LICENSE, but the README badge says GPL-3.0. Its `Bcore/src/main/AndroidManifest.xml` still contains 323 `<uses-permission>` entries (249 unique), including overlays, location, camera, microphone, broad storage, contacts/call-log/SMS and install/package visibility permissions. Its app manifest independently requests `QUERY_ALL_PACKAGES`, `READ_EXTERNAL_STORAGE` and `WRITE_EXTERNAL_STORAGE`. The root build deliberately sets target SDK 28, and the release build uses `signingConfigs.debug`. Its compatibility notes disclose that kernel-visible socket credentials still expose the host process UID; userspace UID spoofing does not change `SO_PEERCRED`. It is not safe to add to the companion unchanged.
- **[TeguFy/blackbox-android](https://github.com/TeguFy/blackbox-android)** has the same 323/249 Bcore permission footprint and the same broad package/storage permissions in its app manifest. It is not an independent least-privilege implementation.
- **[ZENINXOP/BlackBox](https://github.com/ZENINXOP/BlackBox)** currently exposes a README but no auditable source tree, manifest, build configuration or license file in the repository snapshot reviewed. Its Android 17 and sandbox claims are therefore unverified; it is not eligible for integration.
- **Android Virtualization Framework (AVF/Microdroid)** is the platform-supported VM option, but its framework APIs are `@SystemApi` and require restricted `android.permission.MANAGE_VIRTUAL_MACHINE`. The platform declaration is `signature|preinstalled|development`; the development grant is for controlled adb testing and is not a production permission ordinary third-party companion apps can obtain. This could be reconsidered only for an OEM/preinstalled/system-app distribution, not the current normal companion APK.
- **asLody/VirtualApp** remains useful historical research, but its public source is stale and is not a maintained, production-ready integration target for current Android releases.

**Decision:** no candidate passes the existing manifest, signing, licensing, isolation and device-proof gates. Keep the provider interface only. Do not lower the admission policy or bundle a fork just to produce a visual “guest app” frame. The next acceptable POC is a separately signed, disposable host build for an audited candidate after its host manifest has been stripped and the provider's runtime dependencies and limitations have been documented; it must pass the handset matrix before the companion advertises guest execution.
