# Android companion permission onboarding — implementation slice 1

## Intended product flow

1. User opens **Devices → Add Android Device** in Rub Minds (web UI is a separate follow-on change).
2. User installs and opens the Android companion APK.
3. Companion displays launcher apps; owner chooses individual apps.
4. Owner separately chooses whether the Rub Minds keyboard may insert drafts into each selected app.
5. Owner taps **Enable in Android Settings**, enables **Rub Minds draft keyboard** in the system-owned input-method settings, returns to the companion, then taps **Choose keyboard** and selects it in Android's system picker.
6. The keyboard checks the live foreground editor package and input type against the local per-app grant and requires a deliberate **Insert draft** tap. It refuses password/credential variations and unsupported editor classes.

## Implemented in this slice

- Standalone Android Gradle project under `android-companion/`.
- Package discovery limited to launcher activities through a `<queries>` intent; no broad `QUERY_ALL_PACKAGES` declaration.
- Local app-grant persistence and an exact-package insertion policy.
- Optional input method with local text composition and explicit insertion.
- Unit tests for grant enforcement.

## Not implemented yet

- Rub Minds account pairing, QR redemption, cloud device records, or a Devices page.
- Importing conversations, screen capture, reading notifications, or app-private storage.
- General-purpose remote control, Accessibility Service, screen overlays, installing/uninstalling other apps, or work-profile selection.
- Group-triggered actions. The keyboard requires a local person to compose a draft and tap Insert.

## Security requirements for subsequent slices

- Pair through a short-lived, one-use challenge redeemed using the signed-in owner's session; store only a revocable device public key or credential digest server-side.
- Bind every request to owner, device, room, selected package, and a narrow capability.
- Use nonce, expiry, request-body digest, and replay protection for device commands.
- Require local unlock/confirmation for sensitive actions. A group message or model-generated instruction must never expand device capabilities.
- Keep app inventory, screen content, and notification content local by default; transmit only explicitly selected app identifiers and approved drafts.
- Give users per-device disconnect, per-app revoke, emergency pause, and audit history.
- Treat Accessibility, screen capture, notification access, and file permissions as separate opt-in capability modules with platform and store-policy review; do not request them merely to shorten onboarding.

## Acceptance gates

- Build with JDK 17 and Android SDK 35.
- Run `:app:testDebugUnitTest` and `:app:assembleDebug`.
- Physical-device verification on Android 13+ and at least one OEM device: app discovery, keyboard enable/select, exact-package denial, explicit insertion, and no-submit behavior.
- Confirm there are no manifest requests for all-files, accessibility, overlay, notifications, media projection, or broad package inventory.
- Complete a threat-model review before implementing cloud/device pairing.

## Status

The Android source is on a feature branch and is not merged, released, or installed on a phone. No APK build or physical-device test has been claimed.
