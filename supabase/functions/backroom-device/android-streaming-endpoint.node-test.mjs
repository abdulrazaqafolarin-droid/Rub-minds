import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL("../../../" + path, import.meta.url), "utf8");

test("Android stream Edge actions keep human auth, device bearer and platform boundaries separate", async () => {
  const endpoint = await read("supabase/functions/backroom-device/index.ts");
  assert.match(endpoint, /action === 'android\/session-start'/);
  assert.match(endpoint, /action === 'android\/command'/);
  assert.match(endpoint, /action === 'android\/commands'/);
  assert.match(endpoint, /action === 'android\/signal'/);
  assert.match(endpoint, /action === 'android\/ack'/);
  assert.match(endpoint, /action === 'android\/session-close'/);
  assert.match(endpoint, /const userId = await owner\(req\)/);
  assert.match(endpoint, /const current = await device\(req\)/);
  assert.match(endpoint, /binding\.platform !== 'android'/);
  assert.match(endpoint, /activeDesktopSession\(/); 
  assert.match(endpoint, /android_screen_session_already_active/);
  assert.match(endpoint, /android_expired_session_cleanup_failed/);
  assert.match(endpoint, /select\\('session_id'\\)\\.eq\\('device_id', start\\.deviceId\\)/);
  assert.match(endpoint, /backroom_device_apps/);
  assert.match(endpoint, /backroom_android_commands/);
  assert.match(endpoint, /one_active_screen_per_device/);
  assert.match(endpoint, /row_number\\(\\) over \\(partition by device_id/);
  assert.match(endpoint, /mapAndroidQueuedCommand/);
  assert.match(endpoint, /ANDROID_SESSION_LEASE_MS/);
  assert.match(endpoint, /android_session_heartbeat_failed/);
  assert.match(endpoint, /nextSessionExpiry/);
  assert.match(endpoint, /ANDROID_SESSION_LEASE_MS/);
  assert.match(endpoint, /action: command.command/);
  assert.match(endpoint, /lease_until/);
  assert.match(endpoint, /android_session_close_failed/);
  assert.match(endpoint, /validateAndroidSessionStart/);
  assert.match(endpoint, /validateAndroidDeviceCommand/);
  assert.match(endpoint, /validateAndroidCommandAck/);
});

test("Android queue and media components do not add an inbound phone listener or cloud-start capture action", async () => {
  const companion = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidScreenShareService.kt");
  const setup = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidStreamSetupActivity.kt");
  assert.match(companion, /HttpsURLConnection|CloudDeviceApi/);
  assert.match(companion, /ACTION_START/);
  assert.match(setup, /createScreenCaptureIntent\(\)/);
  assert.match(setup, /startForegroundService\(service\)/);
  assert.match(setup, /AppGrantStore\(this\)\.get\(targetPackageName, signer\)/);
  assert.doesNotMatch(companion, /ServerSocket|HttpServer|127\.0\.0\.1|localhost/);
  assert.doesNotMatch(companion, /startCapture\(.*fromCloud/);
});
