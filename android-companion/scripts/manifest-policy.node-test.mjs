import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifestUrl = new URL("../app/src/main/AndroidManifest.xml", import.meta.url);
const keyboardUrl = new URL("../app/src/main/java/app/rubminds/companion/DraftInputMethodService.kt", import.meta.url);
const policyUrl = new URL("../app/src/main/java/app/rubminds/companion/AppGrantPolicy.kt", import.meta.url);
const identityUrl = new URL("../app/src/main/java/app/rubminds/companion/AppIdentity.kt", import.meta.url);
const storeUrl = new URL("../app/src/main/java/app/rubminds/companion/AppGrantStore.kt", import.meta.url);
const activityUrl = new URL("../app/src/main/java/app/rubminds/companion/MainActivity.kt", import.meta.url);
const read = async (url) => readFile(url, "utf8");

test("companion does not request broad or sensitive Android permissions", async () => {
  const manifest = await read(manifestUrl);
  const forbidden = [
    "android.permission.INTERNET",
    "android.permission.MANAGE_EXTERNAL_STORAGE",
    "android.permission.QUERY_ALL_PACKAGES",
    "android.permission.SYSTEM_ALERT_WINDOW",
    "android.permission.BIND_ACCESSIBILITY_SERVICE",
    "android.permission.RECEIVE_BOOT_COMPLETED",
    "android.permission.PACKAGE_USAGE_STATS",
    "android.permission.REQUEST_INSTALL_PACKAGES",
    "android.permission.READ_LOGS",
  ];
  for (const permission of forbidden) {
    assert.equal(manifest.includes(permission), false, "Unexpected permission: " + permission);
  }
  assert.equal(/<uses-permission\b/.test(manifest), false, "No runtime permission is required by this slice");
  assert.match(manifest, /android:usesCleartextTraffic="false"/);
  assert.match(manifest, /android.permission.BIND_INPUT_METHOD/);
});

test("package visibility is declared only for launcher activities", async () => {
  const manifest = await read(manifestUrl);
  assert.match(manifest, /<queries>/);
  assert.match(manifest, /<action android:name="android.intent.action.MAIN"\s*\/>/);
  assert.match(manifest, /<category android:name="android.intent.category.LAUNCHER"\s*\/>/);
  assert.match(manifest, /<\/queries>/);
  assert.doesNotMatch(manifest, /<uses-permission\b[^>]*android:name="android.permission\.QUERY_ALL_PACKAGES"/);
});

test("draft insertion is gated by exact app, capability and field type", async () => {
  const policy = await read(policyUrl);
  assert.match(policy, /grant\.signingCertificateSha256 == currentSigningCertificateSha256/);
  assert.match(policy, /isSupportedInputType\(inputType\)/);
  assert.match(policy, /!isSensitiveInput\(inputType\)/);
  assert.match(policy, /TYPE_TEXT_VARIATION_PASSWORD/);
  assert.match(policy, /TYPE_TEXT_VARIATION_VISIBLE_PASSWORD/);
  assert.match(policy, /TYPE_TEXT_VARIATION_WEB_PASSWORD/);
  assert.match(policy, /TYPE_NUMBER_VARIATION_PASSWORD/);
  assert.match(policy, /packageNamePattern/);
});

test("keyboard rechecks the live target immediately before insertion and never submits", async () => {
  const keyboard = await read(keyboardUrl);
  assert.match(keyboard, /currentInputEditorInfo/);
  assert.match(keyboard, /liveEditor\.packageName != packageName/);
  assert.match(keyboard, /isInsertAllowed\(verifyCurrentSigner = true\)/);
  assert.match(keyboard, /currentInputConnection/);
  assert.match(keyboard, /commitText\(text, 1\)/);
  assert.doesNotMatch(keyboard, /performEditorAction|sendKeyEvent|KEYCODE_ENTER/);
  assert.doesNotMatch(keyboard, /OkHttpClient|HttpURLConnection|Socket\(/);
});

test("per-app approvals are bound to the installed APK signing identity", async () => {
  const identity = await read(identityUrl);
  const store = await read(storeUrl);
  const activity = await read(activityUrl);
  const policy = await read(policyUrl);
  assert.match(identity, /GET_SIGNING_CERTIFICATES/);
  assert.match(identity, /GET_SIGNATURES/);
  assert.match(identity, /signingInfo\.apkContentsSigners\?\.toList\(\)/);
  assert.doesNotMatch(identity, /signingCertificateHistory\?\.lastOrNull\(\)/);
  assert.match(identity, /SHA-256/);
  assert.match(store, /app_grants_v2/);
  assert.match(store, /signingCertificateSha256/);
  assert.match(store, /app_grants_v1/);
  assert.match(policy, /grant\.signingCertificateSha256 == currentSigningCertificateSha256/);
  assert.match(activity, /AppIdentity\.signingCertificateSha256/);
});
