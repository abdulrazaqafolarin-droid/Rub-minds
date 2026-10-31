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
  const migration = await read("supabase/migrations/20261031183000_backroom_android_streaming_commands.sql");
  assert.match(migration, /can_access_backroom_android_realtime_topic/);
  assert.match(migration, /backroom-android:'\|\|d.device_id::text\|\|':'\|\|b.room_id::text/);
  assert.match(migration, /backroom_android_room_member_receive_private_broadcast/);
  assert.match(migration, /p\\.room_id=b\\.room_id/);
  assert.match(migration, /r\\.id=b\\.room_id and r\\.owner_id=\\(select auth\\.uid\\(\\)\\)/);
  assert.match(endpoint, /ANDROID_SESSION_LEASE_MS/);
  assert.match(endpoint, /android_session_heartbeat_failed/);
  assert.match(endpoint, /android_ack_binding_check_failed/);
  assert.match(endpoint, /android_ack_room_binding_revoked/);
  assert.match(endpoint, /android_session_binding_check_failed/);
  assert.match(endpoint, /device_room_binding_revoked/);
  assert.match(endpoint, /stopSessionIds/);
  assert.match(endpoint, /invalid_android_command_poll/);
  assert.match(endpoint, /activeSessionRow/);
  assert.match(endpoint, /Date\.parse\(activeSessionRow\.expires_at\)/);
  assert.match(endpoint, /activeSessionRow\?\.session_type === 'screen'/);
  assert.match(endpoint, /input.sessionId/);
  assert.match(companion, /pollFields.put\("sessionId", sessionId\)/);
  assert.match(endpoint, /nextSessionExpiry/);
  assert.match(endpoint, /ANDROID_SESSION_LEASE_MS/);
  assert.match(endpoint, /action: command.command/);
  assert.match(endpoint, /lease_until/);
  assert.match(endpoint, /android_session_close_failed/);
  assert.match(endpoint, /event: 'android_signal'/);
  assert.match(endpoint, /event: 'android_response'/);
  assert.match(endpoint, /event: 'android_signal'/);
  assert.match(endpoint, /event: 'android_response'/);
  assert.match(endpoint, /validateAndroidSessionStart/);
  assert.match(endpoint, /validateAndroidDeviceCommand/);
  assert.match(endpoint, /validateAndroidCommandAck/);
});

test("Android queue and media components do not add an inbound phone listener or cloud-start capture action", async () => {
  const companion = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidScreenShareService.kt");
  const setup = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidStreamSetupActivity.kt");
  assert.match(companion, /HttpsURLConnection|CloudDeviceApi/);
  assert.match(companion, /ACTION_START/);
  assert.match(companion, /PEER_DISCONNECT_GRACE_SECONDS = 20L/);
  assert.match(companion, /android_offer_rejected/);
  assert.match(companion, /stopSessionIds/);
  assert.match(companion, /device_room_binding_revoked/);
  assert.match(companion, /android\/session-close/);
  assert.match(companion, /stopCapture\\("android_offer_rejected"\\)/);
  assert.match(companion, /webrtc_peer_disconnected/);
  assert.match(companion, /fun revokeLocalTouch\\(context: Context\\)/);
  assert.match(companion, /localControlGranted = false/);
  assert.match(companion, /val allowedKeys = setOf/);
  assert.match(companion, /durationMillis !in 40\\.\\.1_500/);
  assert.match(companion, /fun revokeLocalTouch\\(context: Context\\)/);
  assert.match(companion, /localControlGranted = false/);
  assert.match(setup, /createScreenCaptureIntent\(\)/);
  assert.match(setup, /startForegroundService\(service\)/);
  assert.match(setup, /AppGrantStore\(this\)\.get\(targetPackageName, signer\)/);
  assert.doesNotMatch(companion, /ServerSocket|HttpServer|127\.0\.0\.1|localhost/);
  assert.doesNotMatch(companion, /startCapture\(.*fromCloud/);
});

test("control ACK broadcasts before marking the leased queue row acknowledged and supports replay", async () => {
  const endpoint = await read("supabase/functions/backroom-device/index.ts");
  const handler = endpoint.slice(endpoint.indexOf("if (action === 'android/ack')"), endpoint.indexOf("if (action === 'desktop/inventory')"));
  assert.match(handler, /row.status === 'acked'/);
  assert.match(handler, /row.result !== ack.result/);
  assert.ok(handler.indexOf("await broadcastControlResult()") < handler.indexOf(".update({ status: 'acked'"));
  assert.match(handler, /android_control_result_delivery_failed/);
  assert.match(handler, /replayed: true/);
});

test("Android view-offer retries reuse the existing peer after a lost queue ACK", async () => {
  const service = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidScreenShareService.kt");
  const block = service.slice(service.indexOf('"view_offer" ->'), service.indexOf('"request_control" ->'));
  assert.match(block, /activeSessionId == sessionId/);
  assert.match(block, /activeAppPackage == appPackage/);
  assert.match(block, /peer != null/);
  assert.match(block, /if \(answerAlreadySent\) acknowledgePendingOffer/);
});
test("Phone Frame clearly reports hidden app windows and requires second-device viewing", async () => {
  const control = await read("src/BackroomAndroidControl.tsx");
  assert.match(control, /The selected app window is hidden on the phone/);
  assert.match(control, /Open this Backroom control page on a second device/);
  assert.match(control, /setSourceVisible\(false\)/);
  assert.match(control, /disabled=\{!viewReady \|\| !sourceVisible/);
});

test("Android SDP answer publication is atomically single-flight across ICE callbacks", async () => {
  const service = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidScreenShareService.kt");
  const start = service.indexOf("private fun sendLocalAnswer");
  const end = service.indexOf("private var pendingOfferCommandId", start);
  const body = service.slice(start, end);
  assert.match(body, /val claim = synchronized\(this\)/);
  assert.match(body, /answerAlreadySent = true/);
  assert.match(body, /if \(!claim\) return/);
});
test("stale browser stop callbacks cannot close a newer Android stream", async () => {
  const control = await read("src/BackroomAndroidControl.tsx");
  const start = control.indexOf("const stopRemote");
  const end = control.indexOf("useEffect(() =>", start);
  const body = control.slice(start, end);
  assert.match(body, /sessionRef.current === expectedSession/);
});

test("MediaProjection starts the track and then follows OS app-window visibility", async () => {
  const service = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidScreenShareService.kt");
  assert.match(service, /capturedContentVisible = true/);
  assert.match(service, /onCapturedContentVisibilityChanged/);
  assert.match(service, /setEnabled\(isVisible && !stopping\)/);
});
test("native setup explicitly explains second-device viewing", async () => {
  const setup = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidStreamSetupActivity.kt");
  assert.match(setup, /Open Backroom on your Windows laptop or another device/);
  assert.match(setup, /cannot be on this same phone/);
});

test("Android touch dispatch validates unique gesture IDs and returns completion acknowledgements", async () => {
  const service = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidScreenShareService.kt");
  const touchService = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidTouchAccessibilityService.kt");
  const browser = await read("src/BackroomAndroidControl.tsx");
  assert.match(service, /"gestureId"/);
  assert.match(service, /sendTouchAcknowledgement\(channel, sessionId, gestureId, false\)/);
  assert.match(service, /"kind", "touch_ack"/);
  assert.match(touchService, /onCompleted\(true\)/);
  assert.match(touchService, /onCompleted\(false\)/);
  assert.match(browser, /kind: 'touch_ack'/);
  assert.match(browser, /pendingTouchAcksRef/);
  assert.match(browser, /Android completed the tap\/swipe gesture/);
});

test("touch completion callback is wired through the accessibility service entry point", async () => {
  const touchService = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidTouchAccessibilityService.kt");
  const companion = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidScreenShareService.kt");
  assert.match(touchService, /fun dispatchRemoteGesture\(gesture: RemoteTouchGesture, onResult: \(Boolean\) -> Unit\)/);
  assert.match(touchService, /dispatchRemoteGesture\(gesture, onResult\)/);
  assert.match(touchService, /onResult\(true\)/);
  assert.match(touchService, /onResult\(false\)/);
  assert.match(companion, /AndroidTouchAccessibilityService\.dispatch\([\s\S]+?\) \{ completed ->/);
});

test("Android projection visibility is explicitly relayed over the data channel", async () => {
  const service = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidScreenShareService.kt");
  const browser = await read("src/BackroomAndroidControl.tsx");
  assert.match(service, /onCapturedContentVisibilityChanged/);
  assert.match(service, /"kind", "app_visibility"/);
  assert.match(service, /sendAppVisibility\(channel, sessionId, capturedContentVisible/);
  assert.match(browser, /kind === 'app_visibility'/);
  assert.match(browser, /setSourceVisible\(acknowledgement.visible\)/);
  assert.match(browser, /setControlGranted\(false\)/);
});
