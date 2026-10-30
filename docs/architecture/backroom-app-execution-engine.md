# Backroom app execution engine decision

Status: **decision pending a device-backed proof of concept**. This is an architecture guardrail, not a claim that app virtualization is implemented.

## Product target

Backroom should eventually offer one group-visible Device Frame with four surfaces: Android apps in an isolated phone-shaped space, managed browser sessions/tabs, desktop apps in a desktop window, and terminals in a terminal surface. A human or authorized AI may request launch, close, restart, switch, tap, swipe, type, press keys, or run commands. Every accepted, rejected, and completed action must be attributed to its human/AI actor and appended to the group's durable activity log.

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

### ALEX5402/NewBlackbox — preferred Android 14 proof-of-concept candidate, not integration-ready

Repository: [ALEX5402/NewBlackbox](https://github.com/ALEX5402/NewBlackbox). The GitHub repository metadata and root `LICENSE` file identify Apache-2.0. Its README claims Android 5–14+, no-root userspace virtualization, ARM64/ARMv7/x86 support, and describes a Bcore core module / AAR-style integration.

The source review found important gaps between that top-level pitch and a safe Rub Minds integration:

- The app and Bcore Gradle modules use Java 21 and NDK 29, despite README build guidance saying JDK 17. The root build targets SDK 35 but sets target SDK 28.
- The Bcore manifest contains 323 `uses-permission` entries. It includes `QUERY_ALL_PACKAGES`, `MANAGE_EXTERNAL_STORAGE`, `SYSTEM_ALERT_WINDOW`, location, camera, microphone, contacts, phone/SMS, account-management, package-installation and many legacy/vendor permissions.
- The release app build is configured with the debug signing key. Do not use the published/demo APK as a Rub Minds trust artifact.
- The user guide says root is recommended for full functionality, although the README overview says no root is required. That discrepancy must be resolved with an unrooted proof of concept on the target handset.

This is the most reasonable candidate for a **separate disposable POC** on the target Android 14 phone because its license is clear and its source documents a library module. It is not approved to merge unchanged. The POC must use a dedicated test application ID and signing key, remove unneeded modules/features, inspect the final merged manifest (not just the companion manifest), and prove that the minimum app-install/launch workflow works without granting broad permissions unnecessarily.

### fdavids77/BlackBoxReborn — legal hold pending upstream clarification

Repository: [fdavids77/BlackBoxReborn](https://github.com/fdavids77/BlackBoxReborn). Its README badge and text say GPL-3.0, while GitHub repository metadata and the checked-in root `LICENSE` file identify Apache-2.0. This mismatch makes the intended licensing/provenance unclear. Do not copy, link, distribute or ship its code until the upstream maintainer clarifies the governing license and the full history/dependency graph is audited.

Its README reports Android 14–17 fixes but the listed successful device evidence is limited (Samsung A25 on Android 16 and a Pixel 10 Pro on Android 17), and it documents app-specific gaps such as WhatsApp companion-link handshakes and strong Play Integrity. Those claims need reproducible local testing; they are not a guarantee for this TECNO device.

### Black00Z/Blacks-BlackBox — reject unchanged

Repository: [Black00Z/Blacks-BlackBox](https://github.com/Black00Z/Blacks-BlackBox). Its root LICENSE and GitHub metadata indicate Apache-2.0, but its standalone application is a customized fork with a Java 21 / NDK 29 build, a large third-party dependency set and a broad Bcore permission manifest similar to NewBlackbox. Its README explicitly says compatibility is incomplete and narrows its own validation focus to selected apps / work-profile scenarios. Its release build is configured with debug signing. It is not a safe drop-in runtime.

### Platform virtualization APIs

Android's [Virtualization Framework API documentation](https://android.googlesource.com/platform/packages/modules/Virtualization/+/HEAD/libs/framework-virtualization/README.md) says its Microdroid APIs are system APIs requiring the restricted `MANAGE_VIRTUAL_MACHINE` permission; they are not a general drop-in option for ordinary third-party apps.

**Decision:** NewBlackbox may be used for a disposable, isolated Android 14 POC only after reviewing and trimming its permission surface. No engine has been selected or integrated. Do not claim that a native app is running inside Backroom until an installed guest app has been launched in an isolated instance and its frame is actually rendered in the Backroom Device Frame on a physical device.

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
