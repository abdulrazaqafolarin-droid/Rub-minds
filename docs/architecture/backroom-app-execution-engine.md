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

## Permission UX

Ask only for a permission required by a demonstrated feature, immediately before that feature is enabled. Explain its actual scope and limitations, link to the OS-owned settings page where applicable, and offer “Disagree and exit” or continue without the optional feature. Do not request All Files Access merely because a reference app does: it does not unlock another app's private data. Accessibility and screen-capture capabilities require separate, explicit OS-mediated consent and policy review.

## Delivery stages

1. **Cloud device foundation (current):** pairing, owner approval/revocation, selected app inventory, HTTPS-only device client and group audit events.
2. **Android virtualization spike:** isolated app runtime proof-of-concept and compatibility matrix; no production permission expansion.
3. **Device Frame contract:** unified surface/session/action schema, capability grants, actor attribution, replayable audit events.
4. **Execution drivers:** Android virtual-app driver, desktop driver and terminal driver, each with explicit scopes and confirmation rules.
5. **End-to-end acceptance:** group human and AI launch/switch/operate flows; verify revocation, denied actions, restart behavior and complete audit trail.

A stage is complete only when its acceptance tests run successfully; source-only checks are not a substitute for an installed-device test.
