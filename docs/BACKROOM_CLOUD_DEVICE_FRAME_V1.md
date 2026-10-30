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
