# Backroom Android guest runtime acceptance matrix

Status: **contract and admission policy implemented; no virtualization provider selected or integrated**.

This document is the execution gate for a separate Android physical-device proof of concept. Passing source tests or a library README does not make an app virtualized. The Phone Frame must show a real app process running in an isolated guest container and must receive frames from that guest only.

## Target device and test boundary

- Initial physical target: TECNO KL4 handset, Android 14 as reported by the device owner.
- Read the actual `Build.VERSION.SDK_INT`, `Build.VERSION.RELEASE`, `Build.SUPPORTED_ABIS`, display density and dimensions on the handset during the test. Do not infer ABI from the model name.
- Use a dedicated test Rub Minds group and a throwaway app/test account.
- Use a dedicated guest-provider build variant/application ID and a dedicated release signing key. Do not install an upstream demo APK or a debug-signed artifact as a production-equivalent test.
- Do not import the host-installed app's private data, cookies, account tokens, databases, login session or shared preferences. Sign into the guest instance separately.
- No Production schema, permission, deployment or feature-flag change is part of this proof.

## Provider decision

The current NewBlackbox candidate is **rejected unchanged**. Its current Bcore manifest contains 323 permission entries (249 unique names), including broad package visibility, all-files access, overlay, location, camera, microphone, contacts, phone/SMS and installation permissions. Its app release build uses the debug signing config and targets SDK 28. The README says JDK 17 while the Gradle modules use Java 21 / NDK 29, and the user guide says root is recommended for full functionality. A new candidate must be audited from source and final merged host manifest before a disposable POC.

No candidate is permitted to add:
- any host `<uses-permission>` beyond the companion's current `android.permission.INTERNET`; any additional permission requires a separate security review and an explicit allowlist change;
- any exported host activity, service, receiver or provider beyond the exact existing launcher activity and OS-bound draft-input-method service; a signature permission is not a generic exception;
- `QUERY_ALL_PACKAGES`, `MANAGE_EXTERNAL_STORAGE`, `SYSTEM_ALERT_WINDOW`, accessibility-service exports, or package-installation host permissions;
- camera, microphone, location, SMS, contacts, call-log, phone-state, calendar, account-management or privileged settings/log permissions;
- an inbound localhost listener or an ADB bridge;
- root requirements or host access to another app's private data.

## Admission requirements

The provider must pass `GuestRuntimeAdmissionPolicy` against the final signed release artifact and final merged APK manifest. Evidence must match the exact engine version, release artifact SHA-256, merged-manifest SHA-256 and handset profile. A document-picked APK must be passed only through the granted `content://` URI; the provider re-parses the actual APK and verifies its package and signing certificate. A manifest edit or rebuild invalidates the old physical-device evidence.

Required capabilities:
- rootless execution;
- fresh per-app data containers and isolated guest processes;
- guest-only frame capture;
- touch input and accessibility-backed field targeting;
- draft-only insertion with no Enter/Send;
- Emergency Stop;
- no private app-data import and no inbound network listener.

## Physical-device test sequence

For each app under test (begin with a simple text editor, then ChatGPT and Claude if installable on the device):

| Check | Action | Pass condition |
|---|---|---|
| Install source | Select an installed package or use Android's document picker for an APK | Package name and signing-certificate SHA-256 are independently re-read from the selected source; no arbitrary filesystem path is accepted |
| Fresh instance | Prepare a guest instance | A newly created, empty data-container ID is returned; private data import is false |
| Separate instance | Prepare a second instance of the same app | It receives a different container ID; no cookies, accounts, database or settings are shared |
| Rootless launch | Launch without root or privileged host permission | The app reaches RUNNING and no root prompt is shown |
| Guest frame | Capture the app | Frame is guest-only, has an increasing sequence and matches the active session and instance; no host status bar, other apps or full-device content is mislabeled as guest |
| Coordinate transform | Tap each corner and centre in the Phone Frame | Touch lands at the corresponding guest-app position across portrait/landscape, density scaling and rotation |
| Touch lifecycle | Perform DOWN, MOVE, UP and CANCEL, including multi-touch | Only active pointer IDs are accepted; stale, duplicate, out-of-order or excess pointers are rejected |
| Text target | Drag over one empty text field | The provider receives the current session/instance/frame sequence and normalized drag rectangle, then returns the actual accessibility field identity and bounds; the drag covers at least 65% of that field |
| Unsafe targets | Try password, read-only, disabled, occupied and unexposed custom controls | Each is rejected without changing app text |
| Draft approval | Request a draft | A native local confirmation is required; the opaque receipt binds the session, selection, exact request ID and SHA-256 of the approved text, is single-use and expires |
| Draft insertion | Confirm one plain-text draft | The exact field is re-resolved, verified empty and written once; read-back equals the full draft; submitted is false |
| Replay | Reuse the old selection ID or approval receipt | Rejected; a new drag and fresh local confirmation are required |
| Fresh drag | Drag to a different field, including an invalid field | Old selection and any pending draft are retired immediately |
| Stop/revoke | Stop the guest or revoke the device/session | Guest process and active pointers stop; no further frame, touch or insertion is accepted |
| Process death | Force-stop the companion/provider and reopen | Data-container ownership is recovered safely; no container is silently shared or re-created over existing data |
| Emergency Stop | Invoke the native emergency stop | All guest processes, touch streams, screen frames and pending draft approvals are terminated |
| Network boundary | Inspect device network listeners and traffic | No inbound local server; only required outbound authenticated service connections are used |

## Evidence to record

The final acceptance record must include:
- engine name and immutable version/commit;
- release APK SHA-256 and final merged-manifest SHA-256;
- licence and source provenance;
- device API, ABI, model profile and display geometry;
- test-run ID, date and test operator;
- each acceptance check with pass/fail, evidence and any app-specific limitation;
- installed APK size, guest startup-to-first-frame latency, memory usage, CPU/battery observations and crash/process-death recovery;
- the final permission and exported-component inventory.

The record is represented by `GuestDeviceAcceptanceEvidence`. A result for a different build, merged manifest or handset profile must not set the provider to READY.

## Current implementation boundary

Implemented in this branch:
- provider-neutral install, launch, frame, touch, accessibility-target, draft and stop contracts;
- admission rules for source licence, API/ABI, minimum target SDK, final merged manifest, exported components, permission scope, debug signing and exact artifact/manifest hashes;
- guest-only frame validation and guest/session/frame binding;
- normalized field-target geometry, protected/occupied target rejection and 65% selection coverage;
- UUID-scoped selection/draft IDs, one-use local approval receipts, one-shot selection consumption and no-submit result policy;
- resource bounds for eight guest instances, ten active pointers per session and 1,024 retired selections per session;
- Kotlin/JUnit and Node source-contract regression tests added.

Not implemented or verified:
- no provider implements `GuestRuntimeProvider`;
- no app APK is installed/launched in a guest;
- no guest frame is rendered in the Phone Frame;
- no real guest touch or accessibility query exists;
- no native approval screen issues live guest approval receipts;
- no Android Gradle build, APK install, physical acceptance or provider performance test has passed in this session.

**Do not mark Android virtualized app execution complete until the provider is implemented and every required handset check passes.**


## Provider feasibility re-audit (2026-10-31)

The reviewed alternatives still do not pass admission. BlackBox Reborn's Bcore manifest has 323 permission entries (249 unique); its application manifest requests `QUERY_ALL_PACKAGES` and broad external-storage access, its build targets SDK 28 and signs the release variant with the debug key, and its README license badge conflicts with the Apache-2.0 LICENSE file. TeguFy's BlackBox fork retains the same 323/249 core-manifest permission footprint and broad application-manifest permissions. ZENINXOP/BlackBox did not expose source, build files, a manifest or a license in the repository snapshot reviewed, so its claims are unverified.

AVF/Microdroid is a system VM facility, not an ordinary-app SDK: its APIs are `@SystemApi`, and `MANAGE_VIRTUAL_MACHINE` is declared with restricted `signature|preinstalled|development` protection. The development grant supports controlled adb tests, not production use by a normally installed third-party app. AVF would require a preinstalled/OEM/system-app distribution arrangement.

**No Android guest provider has been selected or integrated.** Keep all candidates blocked until a disposable POC has an audited final merged manifest, consistent licensing, non-debug release signing, API/ABI compatibility and completed physical-device evidence.
