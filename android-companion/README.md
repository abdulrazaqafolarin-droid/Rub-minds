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
gradle -PSUPABASE_URL=https://YOUR_PROJECT.supabase.co -PSUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY :app:testDebugUnitTest :app:assembleDebug
```

You can also set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` in the build environment. Values are generated into `BuildConfig` and are not committed to this repository. The URL is validated at runtime as an HTTPS Supabase project endpoint.

## Pairing flow

1. In the Rub Minds Backroom web page, select a group and create a one-use Android pairing code.
2. Open Rub Minds Companion on the phone and paste the code.
3. The phone creates a random device token, stores it encrypted with Android Keystore, and claims the code over HTTPS.
4. The web UI shows the device as pending. The group owner must approve it.
5. Tap **Check approval** in the phone app. When approved, selected app metadata is synced to that group.
6. The owner can revoke the device from Backroom. The next device status check detects revocation and clears the local bearer credential.

The phone keeps the raw device credential locally; the database stores its digest only. No service-role key or AI/provider credential is embedded in the APK.

## Guest runtime integration gate

The companion currently has **no app virtualization provider**. The code under `app/src/main/java/app/rubminds/companion/guest/` defines the future integration boundary only. It deliberately has no BlackBox, VirtualApp or NewBlackbox dependency.

A provider must pass `GuestRuntimeAdmissionPolicy` and a physical-device acceptance record for the same engine version, signed release-artifact SHA-256, merged-manifest SHA-256 and device profile before it can be advertised as ready. In particular, the final merged host APK manifest must be reviewed; a library's manifest alone is not sufficient. Exported components are restricted to the existing launcher entry point, the OS-bound draft keyboard, or signature-protected internal components. Broad package visibility, all-files access, overlays, SMS/call-log/contacts, camera/microphone/location and package-installation host permissions are not accepted by the current gate.

The contract requires true per-app guest data isolation, guest-only frames, session-bound touch and accessibility targets, empty-field-only draft insertion, a session/selection-bound one-use native approval receipt and emergency stop. It rejects whole-device screenshots as guest frames and rejects Enter/Send. A selection lease is consumed before writing; failed or ambiguous writes require a fresh selection. The included instance/container registry is process-local helper code; a production provider must persist this mapping across process death. The receipt constructor is private and the factory is internal; a provider must issue a receipt only after its native confirmation dialog succeeds. No live provider or native approval screen is wired yet. A complete provider must still be implemented and tested on a physical phone.

## Explicit capability boundaries

This slice supports **app discovery and selected-app inventory only**. It does not clone or virtualize application code, copy another app's private data, embed native apps, capture the screen, or perform remote taps/swipes/typing. Opening a normal installed app is still an Android activity outside a Backroom isolated instance; the companion does not claim otherwise.

`MANAGE_EXTERNAL_STORAGE` is deliberately not requested. It grants broad access to shared storage, not another app's private sandbox (`/data/user/0/<package>` or another app's `Android/data` directory). Existing private logins and app databases cannot be copied by an ordinary app. A future virtualization engine must create a fresh, isolated data container and pass app-specific compatibility tests; the user signs into that instance separately.

Package inventory is restricted to launchable apps visible under the declared `<queries>` filter. A broader all-packages declaration is not included. The external-storage label is based on Android's installed-package metadata; this app does not scan removable media for uninstalled APK files. Work-profile and external-storage app visibility depends on Android profile, package visibility, and OEM behavior.

## Virtualization engine decision

See [`docs/architecture/backroom-app-execution-engine.md`](../docs/architecture/backroom-app-execution-engine.md) for the explicit proof-of-concept gate and current engine review. NewBlackbox was re-audited and is rejected unchanged: its Bcore source manifest has 323 permission entries (249 unique), with broad host privileges. No virtualization library has been integrated.

## Verification status

- Repository Node tests statically verify permissions, HTTPS-only transport, lack of inbound localhost listeners, credential handling, and package query scope.
- Kotlin/JUnit tests cover the existing per-app draft-insertion policy and the guest runtime admission/frame/touch/target/one-shot lease safety contract.
- Node source-contract tests verify that no virtualization dependency or broad permission has been added to the companion.
- **Not yet verified here:** Android Gradle compilation, APK installation, cloud function deployment, migration execution, pairing against a live backend, or physical-device behavior. A real Android build and phone acceptance test are mandatory before release.
