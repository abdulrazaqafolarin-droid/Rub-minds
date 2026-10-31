import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

test("companion requests Internet only for the outbound cloud API", async () => {
  const manifest = await read("app/src/main/AndroidManifest.xml");
  assert.match(manifest, /<uses-permission android:name="android.permission.INTERNET"\s*\/>/);
  const forbidden = [
    "android.permission.MANAGE_EXTERNAL_STORAGE",
    "android.permission.QUERY_ALL_PACKAGES",
    "android.permission.SYSTEM_ALERT_WINDOW",
    "android.permission.BIND_ACCESSIBILITY_SERVICE",
    "android.permission.RECEIVE_BOOT_COMPLETED",
    "android.permission.PACKAGE_USAGE_STATS",
    "android.permission.REQUEST_INSTALL_PACKAGES",
    "android.permission.READ_LOGS",
    "android.permission.WRITE_SECURE_SETTINGS",
    "android.permission.REQUEST_INSTALL_PACKAGES"
  ];
  for (const permission of forbidden) assert.equal(manifest.includes(permission), false, "Unexpected permission: " + permission);
  assert.equal((manifest.match(/<uses-permission\b/g) ?? []).length, 1);
  assert.match(manifest, /android:usesCleartextTraffic="false"/);
  assert.match(manifest, /android.permission.BIND_INPUT_METHOD/);
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

  assert.match(contract, /allowedHostPermissions = setOf\("android\.permission\.INTERNET"\)/);
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
  assert.match(contract, /GuestCaptureScope\.GUEST_APP/);
  assert.match(contract, /GuestCaptureScope\.WHOLE_DEVICE/);
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
  assert.match(contract, /component\.className === "\$\{descriptor\.hostApplicationId\}\.MainActivity"/);
  assert.match(contract, /component\.className === "\$\{descriptor\.hostApplicationId\}\.DraftInputMethodService"/);
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
  assert.match(gradle, /audit\$\{variantTitle\}GuestHostManifest/);
  assert.match(gradle, /ACCESS_EXTERNAL_DTD/);
  assert.match(gradle, /disallow-doctype-decl/);
  assert.match(gradle, /allowedPermissions = setOf\("android\.permission\.INTERNET"\)/);
  assert.match(gradle, /actualExported == expectedExported/);
  assert.match(gradle, /manifestSha256=/);
  assert.match(gradle, /dependsOn\(auditTask\)/);
  assert.match(workflow, /:app:auditDebugGuestHostManifest/);
  assert.match(readme, /actual merged manifest/);
});
