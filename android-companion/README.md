# Rub Minds Android Companion — first native slice

This is an Android-native prototype for the Backroom device-permission direction.

## Included

- Kotlin Android application module under `android-companion/app`.
- Launcher-app discovery using an Android package-visibility intent query; it deliberately does **not** request `QUERY_ALL_PACKAGES`.
- Owner-controlled per-app selection stored locally on the phone.
- Separate per-app draft-insertion grant.
- Optional Rub Minds input method (keyboard). Android requires the user to enable and select it through system keyboard settings; the app cannot silently grant itself that authority.
- The keyboard checks the active editor package against the saved per-app grant and inserts text only after the user taps **Insert draft**.
- Unit tests for the app-grant policy.

## Deliberate security limits

This version does not request all-files access, notification access, screen capture, overlay permission, Accessibility Service, device administrator, or package-installation privileges. Selecting an app is not permission to read its private data. The companion does not capture screens, inspect chats, read passwords, press Send, or submit forms.

The app picker discovers apps that expose launcher activities. Android package-visibility behavior and OEM launchers can affect the list. It does not promise an inventory of every installed package or work-profile apps.

Draft insertion is provided through an optional user-selected keyboard, not invisible cross-app control. Some secure fields and apps may block third-party input methods. Android's keyboard chooser is the approval surface. A keyboard can technically type into any focused field while enabled; this prototype narrows its own Insert action to apps selected by the owner. Users should switch back to their trusted keyboard when they do not need Rub Minds draft insertion.

## Build

Requirements: Android Studio with JDK 17 and Android SDK Platform 35, plus Gradle 8.10.2 or compatible.

From this directory:

```sh
gradle :app:testDebugUnitTest
gradle :app:assembleDebug
```

The output APK is normally at `app/build/outputs/apk/debug/app-debug.apk`.

## Current integration boundary

This first slice is **not yet paired with a Rub Minds account or cloud group**. It establishes native app discovery and owner-approved draft insertion first. The next slice should add QR/deep-link pairing with a short-lived, owner-authenticated device credential, then let Backroom deliver explicitly approved draft payloads to this device. No Supabase service-role key, AI credential, or long-lived bearer secret belongs in the APK.

A device pairing flow must not reuse the desktop local-host token: Android phones cannot reach a different computer's loopback `127.0.0.1`, and the current host API is designed for a same-device local runtime.