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
- No live screen capture, touch injection, accessibility control, desktop driver, terminal runtime or AI-triggered device command executor.
- The Android native project has not been compiled or installed on a physical device in this environment.
- The Supabase migration and Edge Function are source-only. Do not claim pairing is live until a separately approved staging deployment and live pairing test succeed.

## Release gates

1. Apply the migration and deploy the Edge Function to an isolated staging project only after environment/cost review.
2. Build the APK with JDK 17 / Android SDK 35, then install on a physical Android 14 device.
3. Verify launcher package visibility, signer fingerprint, keystore persistence, code expiry/replay, pending/approval/revocation and inventory-sync isolation.
4. Audit an Apache-2.0-compatible virtualization engine (candidate source: Blacks-BlackBox) separately for Android 14+ compatibility, Play Integrity failures, licensing and app-specific behavior. Require a fresh user sign-in inside each isolated app instance.
5. Add screen capture only using Android's user-consented MediaProjection lifecycle.
6. Add input controls only after their Android/Play policy, authorization, foreground identity and independent result-verification design is approved.
7. Implement a durable cloud action queue and append-only group audit trail before enabling AI-directed operations.

Production Supabase and the production Vercel deployment have not been modified by this source change.


## Virtualization engine assessment — 2026-10-30

Candidate reviewed: [Black00Z/Blacks-BlackBox](https://github.com/Black00Z/Blacks-BlackBox), Apache-2.0. The repository is a standalone Android application/engine (not a drop-in Android library). Its current README explicitly narrows validation to a work-profile + Instagram priority path, says compatibility is incomplete, and says game support is not included. Its Gradle app uses Java 21, Kotlin, NDK 29, several external dependencies, and its own app identity; our current companion targets Java 17. This is not safe to embed or ship as a universal clone engine without a dependency/licensing review and an ARM64 Android 14 device smoke test.

Decision: keep the virtualization engine behind a future adapter and do not copy its code into this branch yet. First build and test its unmodified demo on the target device; select one non-sensitive test app; verify fresh isolated data, launch/close/restart, profile-bound package identity, media/URI behavior and uninstall cleanup. Do not promise work-profile apps, game/banking apps, Play Integrity, Google sign-in or every OEM until each is tested.

This branch currently implements launcher-visible app inventory only. The false capability flags in `DEVICE_CAPABILITIES_V1` are deliberate: there is no virtual instance, screen or touch driver yet.

For Preview acceptance, set the Edge Function's `BACKROOM_DEVICE_ALLOWED_ORIGINS` to the exact HTTPS Preview origin as well as the production origin. Do not use wildcard origins. The default value intentionally allows production only.

## User-facing route decision — 2026-10-30

The normal `?backroom=1` entry now opens the cloud Device Frame directly. The older paired-local-host simulator is no longer linked from the Backroom navigation. Its source and isolated tests remain in the repository as a prototype, but it is not part of the normal Device Frame route. This is intentional: the phone and desktop runtimes must connect outbound to the cloud, not be controlled through localhost.

The Android inventory labels installed apps on external SD storage when Android reports the package's external-storage flag. It does not browse arbitrary APK files on removable media or request broad file access. Uninstalled APK import is a separate future feature requiring a user-picked document URI and a compatible virtualization engine.

A separate CI job now builds the native Android module with JDK 17 / Gradle 8.10.2 / Android SDK 35 and runs the Kotlin/JUnit policy tests. It uses placeholder public build configuration only; no production secret is passed to CI.
