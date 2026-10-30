# Rub Minds Android Companion — cloud device foundation

This standalone Android app is the native endpoint for the Backroom device architecture. It connects to the Rub Minds Supabase Edge Function over outbound HTTPS. It does **not** run an HTTP server, open a localhost port, expose an ADB bridge, or require the web app to connect to the phone.

## Implemented in this slice

- Discovers launcher-visible apps using a narrowly scoped Android package-visibility query. This is not a promise to enumerate every installed or work-profile package.
- Lets the user choose app entries locally and stores the current signing-certificate fingerprint for each selection.
- Creates a random 256-bit device credential on pairing and encrypts it with a non-exportable Android Keystore AES-GCM key.
- Redeems a one-use, five-minute pairing code through the Rub Minds cloud. The server stores only SHA-256 digests of pairing codes and device credentials.
- Keeps the device pending until the Rub Minds group owner approves it.
- Syncs only selected app metadata (package name, display label, signer fingerprint, version, and the separate draft-keyboard flag) after approval.
- Uses HTTPS only, disables cleartext traffic and redirects, and sends the device bearer only in the Authorization header.
- The optional input method remains a separate, user-controlled draft-only feature. It never presses Enter or submits a form.

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

## Explicit capability boundaries

This slice supports **app discovery and selected-app inventory only**. It does not clone or virtualize application code, copy another app's private data, embed native apps, capture the screen, or perform remote taps/swipes/typing. Opening a normal installed app is still an Android activity outside a Backroom isolated instance; the companion does not claim otherwise.

`MANAGE_EXTERNAL_STORAGE` is deliberately not requested. It grants broad access to shared storage, not another app's private sandbox (`/data/user/0/<package>` or another app's `Android/data` directory). Existing private logins and app databases cannot be copied by an ordinary app. A future virtualization engine must create a fresh, isolated data container and pass app-specific compatibility tests; the user signs into that instance separately.

Package inventory is restricted to launchable apps visible under the declared `<queries>` filter. A broader all-packages declaration is not included. Work-profile and SD-card app availability depends on Android profile, package visibility, and OEM behavior.

## Verification status

- Repository Node tests statically verify permissions, HTTPS-only transport, lack of inbound localhost listeners, credential handling, and package query scope.
- Kotlin/JUnit tests cover the existing per-app draft-insertion policy.
- **Not yet verified here:** Android Gradle compilation, APK installation, cloud function deployment, migration execution, pairing against a live backend, or physical-device behavior. A real Android build and phone acceptance test are mandatory before release.
