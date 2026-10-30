# Backroom app execution engine decision

Status: **decision pending a device-backed proof of concept**. This is an architecture guardrail, not a claim that app virtualization is implemented.

## Product target

Backroom should eventually offer one group-visible Device Frame with three surfaces: Android apps in an isolated phone-shaped space, desktop apps in a desktop window, and terminals in a terminal surface. A human or authorized AI may request launch, close, restart, switch, tap, swipe, type, press keys, or run commands. Every accepted, rejected, and completed action must be attributed to its human/AI actor and appended to the group's durable activity log.

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

- [BlackBox Reborn](https://github.com/fdavids77/BlackBoxReborn) describes a maintained virtualization fork and claims Android 14–17 compatibility, but its repository states **GPL-3.0** and lists application-specific limitations. The compatibility claims need an actual build and device test; license compatibility must be reviewed before integration.
- [NewBlackBox](https://github.com/ALEX5402/NewBlackbox) describes a userspace app-virtualization engine and advertises an Apache-2.0 license in its repository materials. Verify the exact upstream license, commit health, native build chain and current Android support from the actual checked-out source before relying on those claims.
- Android's [Virtualization Framework API documentation](https://android.googlesource.com/platform/packages/modules/Virtualization/+/HEAD/libs/framework-virtualization/README.md) says its Microdroid APIs are system APIs requiring the restricted `MANAGE_VIRTUAL_MACHINE` permission; they are not a general drop-in option for ordinary third-party apps.
- The [ZCore enhanced BlackBox fork](https://github.com/ZENINXOP/BlackBox) describes free support only through Android 14 and paid support for newer releases, so it does not currently satisfy a no-paid dependency decision without further verification.

**Decision:** do not add any candidate as a dependency yet. Prefer a verifiable, buildable, legally compatible engine that can be included in Rub Minds at no cost, and test it on the actual target phone before designing the control adapter around its API.

## Permission UX

Ask only for a permission required by a demonstrated feature, immediately before that feature is enabled. Explain its actual scope and limitations, link to the OS-owned settings page where applicable, and offer “Disagree and exit” or continue without the optional feature. Do not request All Files Access merely because a reference app does: it does not unlock another app's private data. Accessibility and screen-capture capabilities require separate, explicit OS-mediated consent and policy review.

## Delivery stages

1. **Cloud device foundation (current):** pairing, owner approval/revocation, selected app inventory, HTTPS-only device client and group audit events.
2. **Android virtualization spike:** isolated app runtime proof-of-concept and compatibility matrix; no production permission expansion.
3. **Device Frame contract:** unified surface/session/action schema, capability grants, actor attribution, replayable audit events.
4. **Execution drivers:** Android virtual-app driver, desktop driver and terminal driver, each with explicit scopes and confirmation rules.
5. **End-to-end acceptance:** group human and AI launch/switch/operate flows; verify revocation, denied actions, restart behavior and complete audit trail.

A stage is complete only when its acceptance tests run successfully; source-only checks are not a substitute for an installed-device test.
