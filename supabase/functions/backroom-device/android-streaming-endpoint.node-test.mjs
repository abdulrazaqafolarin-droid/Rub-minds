import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL("../../../" + path, import.meta.url), "utf8");

test("native target attestation is device-bearer scoped and validates active paired app/session identity", async () => {
  const endpoint = await read("supabase/functions/backroom-device/index.ts");
  const protocol = await read("supabase/functions/backroom-device/android-streaming-protocol.mjs");
  const route = endpoint.slice(endpoint.indexOf("if (action === 'android/native-target/register')"), endpoint.indexOf("if (action === 'android/session-start')"));
  assert.match(route, /const current = await device\(req\)/);
  assert.match(route, /current\.platform !== 'android'/);
  assert.match(route, /validateAndroidNativeTargetRegistration/);
  assert.match(route, /verifyActiveDeviceRoomBinding/);
  assert.match(route, /activeDesktopSession/);
  assert.match(route, /session_type !== 'screen'/);
  assert.match(route, /register_backroom_android_native_target/);
  assert.match(route, /revoke_backroom_android_native_target/);
  assert.match(route, /nativeTargetId: data\[0\]\.out_native_target_id/);
  assert.match(route, /p_provider_conversation_identity_digest: registration\.providerConversationIdentityDigest/);
  const receipt = route.slice(route.indexOf("return json(201"), route.indexOf("if (action === 'android/native-target/revoke')"));
  assert.doesNotMatch(receipt, /providerConversationIdentityDigest|composerIdentityDigest|sendControlIdentityDigest|appSignerSha256/);
  assert.match(protocol, /providerConversationIdentityDigest/);
  assert.match(protocol, /!exactKeys\(value, keys\)/);
});

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
  assert.ok(endpoint.includes(".select('session_id').eq('device_id', start.deviceId)"));
  assert.match(endpoint, /backroom_device_apps/);
  assert.match(endpoint, /backroom_android_commands/);
  assert.match(endpoint, /mapAndroidQueuedCommand/);
  const migration = await read("supabase/migrations/20261031183000_backroom_android_streaming_commands.sql");
  assert.match(migration, /can_access_backroom_android_realtime_topic/);
  assert.match(migration, /backroom-android:'\|\|d.device_id::text\|\|':'\|\|b.room_id::text/);
  assert.match(migration, /backroom_android_room_member_receive_private_broadcast/);
  assert.ok(migration.includes("backroom_desktop_sessions_one_active_screen_per_device_idx"));
  assert.ok(/p\.room_id\s*=\s*b\.room_id/.test(migration));
  assert.ok(/r\.id\s*=\s*b\.room_id\s+and\s+r\.owner_id\s*=\s*\(select auth\.uid\(\)\)/.test(migration));
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
  assert.match(companion, /pollFields.put\("sessionId", sessionId\)/);
  assert.match(companion, /HttpsURLConnection|CloudDeviceApi/);
  assert.match(companion, /ACTION_START/);
  assert.match(companion, /PEER_DISCONNECT_GRACE_SECONDS = 20L/);
  assert.match(companion, /android_offer_rejected/);
  assert.match(companion, /stopSessionIds/);
  assert.match(companion, /device_room_binding_revoked/);
  assert.match(companion, /android\/session-close/);
  assert.ok(companion.includes('stopCapture("android_offer_rejected")'));
  assert.match(companion, /webrtc_peer_disconnected/);
  assert.ok(companion.includes("fun revokeLocalTouch(context: Context)"));
  assert.match(companion, /localControlGranted = false/);
  assert.match(companion, /val allowedKeys = setOf/);
  assert.ok(companion.includes("durationMillis !in 40..1_500"));
  assert.ok(companion.includes("fun revokeLocalTouch(context: Context)"));
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
  assert.match(touchService, /onResult\(true\)/);
  assert.match(touchService, /onResult\(false\)/);
  assert.ok(browser.includes("acknowledgement.kind !== 'touch_ack'"));
  assert.match(browser, /pendingTouchAcksRef/);
  assert.match(browser, /Android completed the tap\/swipe gesture/);
});

test("touch completion callback is wired through the accessibility service entry point", async () => {
  const touchService = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidTouchAccessibilityService.kt");
  const companion = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidScreenShareService.kt");
  assert.match(touchService, /fun dispatchRemoteGesture\(gesture: RemoteTouchGesture, onResult: \(Boolean\) -> Unit\)/);
  assert.match(touchService, /fun dispatch\([\s\S]+?onResult: \(Boolean\) -> Unit[\s\S]+?dispatchRemoteGesture\(gesture, onResult\)/);
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

test("initial Android visibility state is sent when the SCTP data channel opens", async () => {
  const service = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidScreenShareService.kt");
  const channel = service.slice(service.indexOf("private fun observeInputChannel"), service.indexOf("@Synchronized", service.indexOf("private fun observeInputChannel")));
  assert.match(channel, /DataChannel\.State\.OPEN/);
  assert.match(channel, /sendAppVisibility\(channel, sessionId, capturedContentVisible && !stopping\)/);
});

test("Android provides a separate local touch-disarm control without stopping view capture", async () => {
  const setup = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidStreamSetupActivity.kt");
  const service = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidScreenShareService.kt");
  assert.match(setup, /Disarm remote touch now/);
  assert.match(setup, /RemoteTouchGate\.disarm\(this@AndroidStreamSetupActivity\)/);
  assert.match(setup, /AndroidScreenShareService\.revokeLocalTouch\(this@AndroidStreamSetupActivity\)/);
  assert.match(setup, /View-only sharing can continue/);
  assert.match(service, /fun revokeLocalTouch\(context: Context\)/);
  assert.ok(service.includes("instance?.let { service ->") && service.includes("service.localControlGranted = false"));
});

test("local touch revocation is sent to the browser without ending the view session", async () => {
  const service = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidScreenShareService.kt");
  const browser = await read("src/BackroomAndroidControl.tsx");
  assert.match(service, /"kind", "touch_control_revoked"/);
  assert.match(service, /fun revokeLocalTouch\(context: Context\)/);
  assert.match(service, /service\.sendTouchControlRevoked\(\)/);
  assert.match(browser, /kind === 'touch_control_revoked'/);
  assert.match(browser, /live app view continues without input control/);
  assert.doesNotMatch(service.slice(service.indexOf("private fun sendTouchControlRevoked"),service.indexOf("private fun sendAppVisibility")), /stopCapture/);
});

test("optional Accessibility interruption revokes only touch, not view-only capture", async () => {
  const accessibility = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidTouchAccessibilityService.kt");
  const interrupt = accessibility.slice(accessibility.indexOf("override fun onInterrupt()"), accessibility.indexOf("override fun onDestroy()"));
  assert.match(interrupt, /AndroidScreenShareService\.revokeLocalTouch/);
  assert.doesNotMatch(interrupt, /requestStop|stopCapture/);
});
test("HTTP transient failures count toward bounded Android capture heartbeat shutdown", async () => {
  const service = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidScreenShareService.kt");
  const poll = service.slice(service.indexOf("private fun pollDeviceCommands()"), service.indexOf("private fun processCommand"));
  assert.match(poll, /error\.statusCode in 400\.\.499 && error\.statusCode != 429/);
  assert.match(poll, /consecutivePollFailures \+= 1/);
  assert.match(poll, /MAX_POLL_FAILURES/);
  assert.match(poll, /device_cloud_heartbeat_lost/);
});

test("Android screen service declares a single volatile stop flag and aborts a poll batch after stop", async () => {
  const service = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidScreenShareService.kt");
  const stoppingDeclarations = service.split("\n").filter(line => /^\s*(?:@Volatile\s+)?private var stopping = false\s*$/.test(line));
  assert.equal(stoppingDeclarations.length, 1);
  assert.match(service, /for \(index in 0 until commands\.length\(\)\) \{\s+if \(stopping\) break/);
  assert.match(service, /private fun processCommand\(token: String, command: JSONObject\) \{\s+if \(stopping\) return/);
});

test("local touch revoke invalidates a late pending control grant response", async () => {
  const browser = await read("src/BackroomAndroidControl.tsx");
  const start = browser.indexOf("acknowledgement.kind === 'touch_control_revoked'");
  const end = browser.indexOf("acknowledgement.kind === 'app_visibility'", start);
  const handler = browser.slice(start, end);
  assert.match(handler, /pendingControlRequestRef\.current = ''/);
  assert.match(handler, /clearTimeout\(controlRequestTimerRef\.current\)/);
  const response = browser.slice(browser.indexOf("channel.on('broadcast', { event: 'android_response'"), browser.indexOf("channel.subscribe"));
  assert.match(response, /payload.requestId !== pendingControlRequestRef.current/);
});

test("Android app-window sharing UI names the QPR2 compatibility boundary and prints build identity", async () => {
  const setup = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidStreamSetupActivity.kt");
  assert.match(setup, /Android 14 QPR2/);
  assert.match(setup, /cancel rather than sharing the whole phone/);
  assert.match(setup, /Build\.VERSION\.SDK_INT/);
  assert.match(setup, /Build\.DISPLAY/);
  assert.match(setup, /Build\.VERSION\.INCREMENTAL/);
});

test("Phone Frame preserves the latest Android visibility message across first video-track delivery", async () => {
  const control = await read("src/BackroomAndroidControl.tsx");
  assert.match(control, /sourceVisibilityRef = useRef<boolean \| null>\(null\)/);
  assert.match(control, /sourceVisibilityRef\.current = acknowledgement\.visible/);
  assert.match(control, /sourceVisibilityRef\.current \?\? stream\.getVideoTracks\(\)\.every/);
  assert.match(control, /sourceVisibilityRef\.current = null/);
  const hidden = control.slice(control.indexOf("if (!acknowledgement.visible)"), control.indexOf("} else {", control.indexOf("if (!acknowledgement.visible)")));
  assert.match(hidden, /pendingControlRequestRef\.current = ''/);
  assert.match(hidden, /clearTimeout\(controlExpiryRef\.current\)/);
});

test("Android ignores transient null foreground roots but still stops on a known app switch", async () => {
  const accessibility = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidTouchAccessibilityService.kt");
  const event = accessibility.slice(accessibility.indexOf("override fun onAccessibilityEvent"), accessibility.indexOf("override fun onInterrupt"));
  assert.match(event, /activePackage != null && activePackage != target/);
  assert.match(accessibility, /activePackageName = currentRootPackage\(\)/);
});
test("Phone Frame preserves hidden status if app-visibility message precedes first video track", async () => {
  const control = await read("src/BackroomAndroidControl.tsx");
  assert.match(control, /const initiallyVisible = sourceVisibilityRef\.current \?\? stream\.getVideoTracks\(\)\.every/);
  assert.match(control, /notify\(initiallyVisible\s*\?/);
  assert.match(control, /Bring it to the foreground to resume the stream/);
});

test("Phone Frame Back action is OS-dispatched only with the same local touch and app identity gate", async () => {
  const service = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidScreenShareService.kt");
  const accessibility = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidTouchAccessibilityService.kt");
  const browser = await read("src/BackroomAndroidControl.tsx");
  assert.match(service, /action != "back"/);
  assert.match(service, /localControlGranted &&[\s\S]+?RemoteTouchGate\.isArmed\(this@AndroidScreenShareService\)/);
  assert.match(service, /sendNavigationAcknowledgement\(channel, sessionId, navigationId, action, accepted\)/);
  assert.match(accessibility, /performGlobalAction\(GLOBAL_ACTION_BACK\)/);
  assert.match(accessibility, /boundSessionId != sessionId \|\| boundPackageName != packageName/);
  assert.match(accessibility, /AppGrantStore\(this\)\.get\(packageName, signer\)/);
  assert.match(browser, /sendNavigationAction\('back'\)/);
  assert.ok(browser.includes("acknowledgement.kind === 'navigation_ack'"));
  assert.match(browser, /Android dispatched Back in the selected app/);
});

test("Phone Frame renders the gated Back action only when the local touch grant is active", async () => {
  const browser = await read("src/BackroomAndroidControl.tsx");
  assert.match(browser, /<ArrowLeft size=\{14\}\/\> Back/);
  assert.match(browser, /disabled=\{!sourceVisible \|\| !dataReady \|\| busy\} onClick=\{\(\) => sendNavigationAction\('back'\)\}/);
  assert.match(browser, /: <>[\s\S]*?Touch enabled temporarily[\s\S]*?sendNavigationAction\('back'\)/);
  assert.ok(browser.includes("acknowledgement.kind === 'navigation_ack'"));
  assert.match(browser, /Android dispatched Back in the selected app/);
});

test("native wake ACK is bound to the stored Android device, room, session, request and canonical handoff", async () => {
  const endpoint = await read("supabase/functions/backroom-device/index.ts");
  const handler = endpoint.slice(
    endpoint.indexOf("if (action === 'android/ack')"),
    endpoint.indexOf("if (action === 'desktop/inventory')")
  );
  assert.match(handler, /row\.command\.deviceId !== current\.device_id/);
  assert.match(handler, /row\.command\.roomId !== row\.room_id/);
  assert.match(handler, /row\.command\.sessionId !== row\.session_id/);
  assert.match(handler, /row\.command\.requestId !== row\.request_id/);
  assert.match(handler, /row\.command\.appPackageName !== handoff\.appId/);
  assert.match(handler, /validateAndroidNativeWakeResult\(ack\.nativeWakeResult, handoff\)/);
  assert.match(handler, /let nativeWakeHandoff: ReturnType/);
  assert.match(handler, /nativeWakeHandoff = handoff/);
  assert.match(handler, /nativeWakeHandoff/);
  assert.match(handler, /native_wake_preflight_denied/);
  assert.match(handler, /native_wake_needs_review/);
  assert.match(handler, /select\('status,result,result_payload'\)/);
  assert.match(handler, /sameNativeWakeResult\(latest\.result_payload, ack\.nativeWakeResult/);
  assert.match(handler, /android_ack_result_conflict/);
  assert.match(handler, /native_wake_submitted/);
  assert.match(handler, /row\.status !== 'leased'/);
});

test("native wake ACK stores bounded evidence privately and broadcasts no target identity digests", async () => {
  const endpoint = await read("supabase/functions/backroom-device/index.ts");
  const migration = await read("supabase/migrations/20261103133000_backroom_android_native_wake_result_evidence.sql");
  const handler = endpoint.slice(
    endpoint.indexOf("if (action === 'android/ack')"),
    endpoint.indexOf("if (action === 'desktop/inventory')")
  );
  const broadcastStart = handler.indexOf("const broadcastNativeWakeResult");
  const broadcastEnd = handler.indexOf("const stableJson", broadcastStart);
  const broadcast = handler.slice(broadcastStart, broadcastEnd);
  assert.match(migration, /add column if not exists result_payload jsonb/);
  assert.match(migration, /octet_length\(result_payload::text\) <= 8192/);
  assert.match(endpoint, /result_payload: ack\.nativeWakeResult \?\? null/);
  assert.match(handler, /sameNativeWakeResult\(row\.result_payload, ack\.nativeWakeResult \?\? null\)/);
  assert.match(broadcast, /event: 'android_native_wake_result'/);
  assert.match(broadcast, /handoffId: nativeWakeHandoff\.handoffId/);
  assert.match(broadcast, /state: ack\.nativeWakeResult\.state/);
  assert.doesNotMatch(broadcast, /composerIdentityDigest|sendControlIdentityDigest|nativeWakeResult: ack\.nativeWakeResult/);
});
