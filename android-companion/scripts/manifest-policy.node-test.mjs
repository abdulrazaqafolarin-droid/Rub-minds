import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

test("companion requests only HTTPS and approved profile handoff permissions", async () => {
  const manifest = await read("app/src/main/AndroidManifest.xml");
  assert.match(manifest, /<uses-permission android:name="android.permission.INTERNET"\s*\/>/);
  const forbidden = [
    "android.permission.MANAGE_EXTERNAL_STORAGE",
    "android.permission.QUERY_ALL_PACKAGES",
    "android.permission.SYSTEM_ALERT_WINDOW",
    "android.permission.RECEIVE_BOOT_COMPLETED",
    "android.permission.PACKAGE_USAGE_STATS",
    "android.permission.REQUEST_INSTALL_PACKAGES",
    "android.permission.READ_LOGS",
    "android.permission.WRITE_SECURE_SETTINGS",
    "android.permission.REQUEST_INSTALL_PACKAGES"
  ];
  for (const permission of forbidden) assert.equal(manifest.includes(permission), false, "Unexpected permission: " + permission);
  assert.match(manifest, /android.permission.INTERACT_ACROSS_PROFILES/);
  assert.equal((manifest.match(/<uses-permission\b/g) ?? []).length, 5);
  assert.match(manifest, /android:usesCleartextTraffic="false"/);
  assert.match(manifest, /android.permission.BIND_INPUT_METHOD/);
  assert.match(manifest, /android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION/);
  assert.match(manifest, /android.permission.BIND_ACCESSIBILITY_SERVICE/);
  assert.match(manifest, /android.accessibilityservice.AccessibilityService/);
  assert.match(manifest, /android:foregroundServiceType="mediaProjection"/);
});

test("package visibility is limited to launcher activities", async () => {
  const manifest = await read("app/src/main/AndroidManifest.xml");
  assert.match(manifest, /<queries>/);
  assert.match(manifest, /android.intent.action.MAIN/);
  assert.match(manifest, /android.intent.category.LAUNCHER/);
  assert.doesNotMatch(manifest, /QUERY_ALL_PACKAGES/);
});

test("device connection uses outbound HTTPS only and refuses redirects", async () => {
  const api = await read("app/src/main/java/app/rubminds/companion/CloudDeviceApi.kt");
  assert.match(api, /HttpsURLConnection/);
  assert.match(api, /protocol != "https"/);
  assert.match(api, /instanceFollowRedirects = false/);
  assert.match(api, /functions\/v1\/backroom-device/);
  assert.doesNotMatch(api, /ServerSocket|Socket\(|127\.0\.0\.1|localhost|HttpServer/);
  assert.match(api, /Authorization/);
  assert.match(api, /BuildConfig\.SUPABASE_PUBLISHABLE_KEY/);
});

test("device bearer credential is encrypted with Android Keystore", async () => {
  const vault = await read("app/src/main/java/app/rubminds/companion/DeviceCredentialVault.kt");
  assert.match(vault, /AndroidKeyStore/);
  assert.match(vault, /AES\/GCM\/NoPadding/);
  assert.match(vault, /setRandomizedEncryptionRequired\(true\)/);
  assert.match(vault, /credential_ciphertext/);
  assert.match(vault, /\.commit\(\)/, "Pairing credentials must persist synchronously before a one-use network redemption.");
});

test("pairing is disabled without cloud configuration and cannot strand an unsent token", async () => {
  const activity = await read("app/src/main/java/app/rubminds/companion/MainActivity.kt");
  assert.match(activity, /isEnabled = pairConsent\.isChecked && cloudApi != null/);
  assert.match(activity, /if \(cloudApi == null\) \{/);
});

test("selected inventory is the only app information sent to cloud", async () => {
  const activity = await read("app/src/main/java/app/rubminds/companion/MainActivity.kt");
  assert.match(activity, /CATEGORY_LAUNCHER/);
  assert.match(activity, /syncInventoryBlocking/);
  assert.match(activity, /draftInsertionAllowed/);
  assert.match(activity, /signingCertificateSha256/);
  assert.doesNotMatch(activity, /MANAGE_EXTERNAL_STORAGE|copy.*private.*data/i);
});

test("keyboard retains exact-package, signer and no-submit restrictions", async () => {
  const keyboard = await read("app/src/main/java/app/rubminds/companion/DraftInputMethodService.kt");
  const policy = await read("app/src/main/java/app/rubminds/companion/AppGrantPolicy.kt");
  assert.match(keyboard, /currentInputEditorInfo/);
  assert.match(keyboard, /isInsertAllowed\(verifyCurrentSigner = true\)/);
  assert.match(keyboard, /commitText\(text, 1\)/);
  assert.doesNotMatch(keyboard, /performEditorAction|sendKeyEvent|KEYCODE_ENTER/);
  assert.match(policy, /grant\.signingCertificateSha256 == currentSigningCertificateSha256/);
  assert.match(policy, /!isSensitiveInput\(inputType\)/);
});

test("installed apps on external storage are labelled without requesting file access", async () => {
  const activity = await read("app/src/main/java/app/rubminds/companion/MainActivity.kt");
  const manifest = await read("app/src/main/AndroidManifest.xml");
  assert.match(activity, /ApplicationInfo\.FLAG_EXTERNAL_STORAGE/);
  assert.match(activity, /"External storage"/);
  assert.match(activity, /"Internal storage"/);
  assert.doesNotMatch(activity, /"SD card"/);
  assert.doesNotMatch(manifest, /MANAGE_EXTERNAL_STORAGE|READ_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE/);
});


test("guest runtime code remains a provider-neutral contract with no bundled virtualization engine", async () => {
  const gradle = await read("app/build.gradle.kts");
  const companion = await read("app/src/main/java/app/rubminds/companion/MainActivity.kt");
  const contract = await read("app/src/main/java/app/rubminds/companion/guest/GuestRuntimeContract.kt");
  assert.doesNotMatch(gradle, /Bcore|BlackBox|VirtualApp|NewBlackbox/i);
  assert.doesNotMatch(companion, /BlackBoxCore|VirtualApp|Bcore/i);
  assert.match(contract, /GuestRuntimeAdmissionPolicy/);
  assert.match(contract, /hostApplicationId/);
  assert.match(contract, /BIND_ACCESSIBILITY_SERVICE/);
  assert.match(contract, /GuestRuntimeDescriptor/);
  assert.match(contract, /isAccessibilityService/);
  assert.match(contract, /AndroidTouchAccessibilityService/);
  assert.match(contract, /GuestLocalApprovalReceipt/);
  assert.match(contract, /draftSha256/);
  assert.match(contract, /guestDraftSha256/);
  assert.match(contract, /this.requestId == requestId/);
  assert.match(contract, /GuestRuntimeProvider/);
  assert.match(contract, /selectedApkDocumentUri/);
  assert.match(contract, /user_selected_apk_content_uri_required/);
  assert.match(contract, /selectedBounds: NormalizedGuestRect/);
  assert.match(contract, /GuestSelectionLease/);
  assert.match(contract, /Re-resolve the same guest field/);
  assert.match(contract, /GuestInstanceIsolationRegistry/);
  assert.match(contract, /GuestDraftResultPolicy/);
  assert.match(contract, /GuestSelectionGuard/);
  assert.match(contract, /GuestInstallPolicy/);
  assert.match(contract, /GuestTouchPolicy/);
  assert.match(contract, /GuestTouchSequenceGuard/);
  assert.match(contract, /MAX_ACTIVE_POINTERS_PER_SESSION = 10/);
  assert.match(contract, /MAX_GUEST_INSTANCES = 8/);
  assert.match(contract, /MAX_RETIRED_SELECTION_IDS_PER_SESSION = 1_024/);
  assert.match(contract, /touch_event_out_of_order/);

  assert.match(contract, /allowedHostPermissions = setOf\(/);
  assert.match(contract, /filterNot \{ it in allowedHostPermissions \}/);
  assert.doesNotMatch(contract, /protectedInternalComponent/);
  assert.match(contract, /GuestRuntimeDecision\.BLOCKED/);
  assert.match(contract, /mergedHostPermissions/);
  assert.match(contract, /mergedHostComponents/);
  assert.match(contract, /GuestPermissionProtection/);
  assert.match(contract, /BIND_INPUT_METHOD/);
  assert.match(contract, /unapproved_exported_components/);
  assert.match(contract, /WRITE_SECURE_SETTINGS/);

  assert.match(contract, /releaseArtifactDebugSigned/);
  assert.match(contract, /releaseArtifactSha256/);
  assert.match(contract, /mergedManifestSha256/);
  assert.match(contract, /enum class GuestCaptureScope \{\s*GUEST_APP,\s*WHOLE_DEVICE\s*\}/);
  assert.match(contract, /frame\.captureScope != GuestCaptureScope\.GUEST_APP/);
  assert.match(contract, /GuestLocalApprovalReceipt/);
  assert.match(contract, /issueAfterNativeConfirmation/);
  assert.match(contract, /internal fun consume\(/);
  assert.match(contract, /private constructor/);
  assert.doesNotMatch(contract, /approvedLocally/);
  assert.match(contract, /submit_not_supported/);
  assert.match(contract, /uuidPattern/);
  assert.match(contract, /digestPattern/);
});

test("phone frame target contract rejects stale, occupied, protected and non-guest targets", async () => {
  const contract = await read("app/src/main/java/app/rubminds/companion/guest/GuestRuntimeContract.kt");
  assert.match(contract, /frame\.sequence/);
  assert.match(contract, /field\.currentText\.isNotEmpty\(\)/);
  assert.match(contract, /field\.password/);
  assert.match(contract, /field\.readOnly/);
  assert.match(contract, /MIN_SELECTION_COVERAGE = 0\.65/);
  assert.match(contract, /MAX_DRAFT_CHARS = 4_000/);
  assert.match(contract, /it\.isISOControl\(\)/);
});

test("guest admission allowlist stays aligned with the real companion manifest and package", async () => {
  const manifest = await read("app/src/main/AndroidManifest.xml");
  const gradle = await read("app/build.gradle.kts");
  const activity = await read("app/src/main/java/app/rubminds/companion/MainActivity.kt");
  const keyboard = await read("app/src/main/java/app/rubminds/companion/DraftInputMethodService.kt");
  const contract = await read("app/src/main/java/app/rubminds/companion/guest/GuestRuntimeContract.kt");

  assert.match(gradle, /namespace = "app\.rubminds\.companion"/);
  assert.match(gradle, /applicationId = "app\.rubminds\.companion"/);
  assert.match(gradle, /targetSdk = 35/);
  assert.match(manifest, /<activity\b/);
  assert.match(manifest, /<service\b/);

  const launcher = manifest.match(/<activity\b[^>]*>/)?.[0] ?? "";
  assert.match(launcher, /android:name="\.MainActivity"/);
  assert.match(launcher, /android:exported="true"/);
  assert.doesNotMatch(launcher, /android:permission=/);

  const inputMethod = manifest.match(/<service\b[^>]*>/)?.[0] ?? "";
  assert.match(inputMethod, /android:name="\.DraftInputMethodService"/);
  assert.match(inputMethod, /android:exported="true"/);
  assert.match(inputMethod, /android:permission="android\.permission\.BIND_INPUT_METHOD"/);

  assert.match(activity, /^package app\.rubminds\.companion$/m);
  assert.match(keyboard, /^package app\.rubminds\.companion$/m);
  assert.match(contract, /component\.className == "\$\{descriptor\.hostApplicationId\}\.MainActivity"/);
  assert.match(contract, /component\.className == "\$\{descriptor\.hostApplicationId\}\.DraftInputMethodService"/);
});

test("all guest runtime JUnit methods remain inside their test class", async () => {
  const source = await read("app/src/test/java/app/rubminds/companion/guest/GuestRuntimeContractTest.kt");
  const testMethods = source.match(/^.*@Test fun /gm) ?? [];
  assert.ok(testMethods.length >= 20, "Expected the guest runtime safety tests to remain present.");
  assert.ok(testMethods.every(line => /^    @Test fun /.test(line)), "JUnit tests must remain class members.");
  assert.equal(source.split("\n").filter(line => line === "}").length, 1, "The test class must have only its final top-level closing brace.");
  assert.match(source, /\n}\s*$/);
});

test("Gradle APK build audits the final merged host manifest and records its digest", async () => {
  const gradle = await read("app/build.gradle.kts");
  const workflow = await read("../.github/workflows/ci.yml");
  const readme = await read("README.md");
  assert.match(gradle, /SingleArtifact\.MERGED_MANIFEST/);
  assert.ok(gradle.indexOf("plugins {") < gradle.indexOf("data class GuestManifestComponentRecord"), "Gradle plugin block must precede executable script declarations.");
  assert.match(gradle, /io\\.github\\.webrtc-sdk:android:150\\.7871\\.04/);
  assert.match(gradle, /audit\$\{variantTitle\}GuestHostManifest/);
  assert.match(gradle, /accessExternalDTD/);
  assert.match(gradle, /disallow-doctype-decl/);
  assert.match(gradle, /allowedPermissions = setOf\(/);
  assert.match(gradle, /actualExported == expectedExported/);
  assert.match(gradle, /AndroidTouchAccessibilityService/);
  assert.match(gradle, /hasTouchServiceMetadata/);
  assert.match(gradle, /duplicateComponents\.isEmpty\(\)/);
  assert.match(gradle, /Component \$className must declare android:exported explicitly/);
  assert.match(gradle, /android\.intent\.action\.MAIN/);
  assert.match(gradle, /android\.intent\.category\.LAUNCHER/);
  assert.match(gradle, /android\.view\.InputMethod/);
  assert.match(gradle, /android\.permission\.BIND_INPUT_METHOD/);
  assert.match(gradle, /accessExternalSchema/);
  assert.match(gradle, /joinToString\(\)/);
  assert.match(gradle, /manifestSha256=/);
  assert.match(gradle, /dependsOn\(auditTask\)/);
  assert.match(workflow, /:app:auditDebugGuestHostManifest/);
  assert.match(readme, /actual merged manifest/);
});

test('local Android launch requires persisted signer-bound approval before and after a system-local confirmation', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../app/src/main/java/app/rubminds/companion/MainActivity.kt', import.meta.url), 'utf8');
  assert.match(source, /text = "Open on this phone"/);
  assert.match(source, /store\.get\(packageName, it\)/);
  assert.match(source, /AppGrantPolicy\.canLaunch\(grant, digest\)/);
  assert.match(source, /AppGrantPolicy\.canLaunch\(currentGrant, currentDigest\)/);
  assert.match(source, /launchGrants\[packageName\] != digest/);
  assert.match(source, /launchGrants\[packageName\] != currentDigest/);
  assert.match(source, /getLaunchIntentForPackage\(packageName\)/);
  assert.match(source, /isEnabled = selected && store\.get\(app\.packageName, digest \?: ""\) != null/);
  assert.match(source, /store\.save\(grants\)\s*\/\/ Rebuild the rows after persisting:[\s\S]*?drawAppRows\(\)/);
  assert.match(source, /setPositiveButton\("Open"\)/);
  assert.doesNotMatch(source, /fun openSelectedAppLocally[\s\S]*?private fun saveChoices[\s\S]*?sendCommand\(/);
});

test("Work Profile DPC is a single system-bound receiver with local signer checks", async () => {
  const manifest = await read("app/src/main/AndroidManifest.xml");
  const gradle = await read("app/build.gradle.kts");
  const receiver = await read("app/src/main/java/app/rubminds/companion/WorkProfileAdminReceiver.kt");
  const coordinator = await read("app/src/main/java/app/rubminds/companion/WorkProfileCoordinator.kt");
  const secretStore = await read("app/src/main/java/app/rubminds/companion/WorkProfileBridgeSecretStore.kt");
  const launcher = await read("app/src/main/java/app/rubminds/companion/WorkProfileAppLauncher.kt");
  const auth = await read("app/src/main/java/app/rubminds/companion/WorkProfileLaunchCommand.kt");
  const activity = await read("app/src/main/java/app/rubminds/companion/MainActivity.kt");
  const contract = await read("app/src/main/java/app/rubminds/companion/guest/GuestRuntimeContract.kt");
  const virtualDeviceProbe = await read("app/src/main/java/app/rubminds/companion/guest/AndroidVirtualDeviceCapabilityProbe.kt");

  assert.match(manifest, /android:name="\.WorkProfileAdminReceiver"/);
  assert.match(manifest, /android:permission="android\.permission\.BIND_DEVICE_ADMIN"/);
  assert.match(manifest, /android:name="android\.app\.device_admin"/);
  assert.match(gradle, /receiver:\$expectedAppId\.WorkProfileAdminReceiver/);
  assert.match(gradle, /expectedExported && exported\\.size == 4/);
  assert.match(gradle, /AndroidTouchAccessibilityService/);
  assert.match(gradle, /hasTouchServiceMetadata/);
  assert.match(gradle, /PROFILE_PROVISIONING_COMPLETE/);
  assert.match(receiver, /setCrossProfilePackages/);
  assert.match(receiver, /getCrossProfilePackages/);
  assert.match(receiver, /profile_owner_confirmed/);
  assert.match(receiver, /PersistableBundle::class\.java/);
  assert.match(receiver, /getParcelableExtra/);
  assert.match(receiver, /setProfileEnabled/);
  assert.match(coordinator, /PersistableBundle/);
  assert.match(coordinator, /EXTRA_PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME, admin/);
  assert.doesNotMatch(coordinator, /resolveActivity/);
  assert.match(secretStore, /hasSecret\(\)/);
  assert.match(secretStore, /secret\.fill\(0\)/);
  assert.match(launcher, /canInteractAcrossProfiles/);
  assert.match(launcher, /targetUserProfiles/);
  assert.match(launcher, /startActivity/);
  assert.match(auth, /HmacSHA256/);
  assert.match(auth, /MessageDigest\.isEqual/);
  assert.match(auth, /MAX_AGE_MILLIS = 60_000L/);
  assert.match(activity, /WorkProfileLaunchAuthenticator\.verify/);
  assert.match(activity, /nonceAlreadyUsed/);
  assert.match(activity, /cross_profile_allowlist_ready/);
  assert.match(activity, /liveEntries\.size >= 2_048/);
  assert.match(activity, /AppIdentity\.signingCertificateSha256/);
  assert.match(activity, /AppGrantStore/);
  assert.doesNotMatch(activity, /performEditorAction|KEYCODE_ENTER/);
  assert.match(contract, /WORK_PROFILE_OWNER_CONFIRMED/);
  assert.match(contract, /WORK_PROFILE_CROSS_PROFILE_ALLOWLIST_VERIFIED/);
  assert.match(contract, /WORK_PROFILE_SIGNER_BOUND_LAUNCH_VERIFIED/);
  assert.match(contract, /acceptance_isolation_boundary_mismatch/);
  assert.match(contract, /isDeviceAdminReceiver/);
  assert.match(contract, /unexpected_exported_entrypoint_count/);
  assert.match(virtualDeviceProbe, /VirtualDeviceManager::class\.java/);
  assert.match(virtualDeviceProbe, /FEATURE_ACTIVITIES_ON_SECONDARY_DISPLAYS/);
  assert.match(virtualDeviceProbe, /PLATFORM_PRESENT_BUT_SYSTEM_ROLE_REQUIRED/);
  assert.match(virtualDeviceProbe, /visibleVirtualDeviceCount/);
  assert.match(activity, /AndroidVirtualDeviceCapabilityProbe\.read/);
  assert.doesNotMatch(manifest, /CREATE_VIRTUAL_DEVICE/);
});


test("Android stream answer callback contains real Kotlin lines, not escaped newline text", async () => {
  const service = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidScreenShareService.kt");
  assert.match(service, /override fun onSetSuccess\(\) \{\s+if \(connection\.iceGatheringState\(\)/);
  assert.equal(service.includes("\\n"), false, "Kotlin source must not contain literal backslash-n sequences from templated edits.");
});


test("local touch revocation remains fail-closed when preference persistence fails", async () => {
  const gate = await read("app/src/main/java/app/rubminds/companion/RemoteTouchGate.kt");
  const service = await read("app/src/main/java/app/rubminds/companion/AndroidScreenShareService.kt");
  assert.match(gate, /@Volatile private var processRevoked = false/);
  assert.match(gate, /if \(processRevoked\) return false/);
  assert.match(gate, /processRevoked = true[\s\S]*runCatching/);
  assert.match(gate, /processRevoked = false/);
  assert.match(service, /localControlGranted = false[\s\S]*AndroidTouchAccessibilityService\.clearActiveSession\(activeSessionId\)[\s\S]*RemoteTouchGate\.disarm\(this\)[\s\S]*runCatching \{ closePeer\(\) \}/);
  assert.match(service, /fun revokeLocalTouch\(context: Context\)[\s\S]*AndroidTouchAccessibilityService\.clearActiveSession\(\)/);
});


test("Android acknowledges malformed touch gestures with an explicit rejection", async () => {
  const service = await read("app/src/main/java/app/rubminds/companion/AndroidScreenShareService.kt");
  const start = service.indexOf('val gestureId = input.optString("gestureId")');
  const end = service.indexOf("val gesture = RemoteTouchGesture(", start);
  assert.ok(start >= 0 && end > start, "touch parser and dispatch boundary must remain present");
  const parser = service.slice(start, end);
  assert.match(parser, /input\.optString\("kind"\) != "touch"[\s\S]*!UUID_PATTERN\.matches\(gestureId\)[\s\S]*input\.optString\("sessionId"\) != sessionId[\s\S]*input\.optString\("appPackageName"\) != appPackage/);
  assert.match(parser, /val rejectGesture = \{ sendTouchAcknowledgement\(channel, sessionId, gestureId, false\) \}/);
  assert.match(parser, /input\.keys\(\)[\s\S]*rejectGesture\(\)/);
  assert.match(parser, /else \{[\s\S]*rejectGesture\(\)[\s\S]*return/);
  assert.match(parser, /optJSONObject\("from"\)[\s\S]*rejectGesture\(\)/);
  assert.match(parser, /optJSONObject\("to"\)[\s\S]*rejectGesture\(\)/);
  assert.match(parser, /durationValue\.toDouble\(\) % 1\.0 != 0\.0[\s\S]*rejectGesture\(\)/);
  assert.match(parser, /durationMillis !in 40\.\.1_500[\s\S]*rejectGesture\(\)/);
});
