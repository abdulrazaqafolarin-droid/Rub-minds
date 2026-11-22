import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL("../../" + path, import.meta.url), "utf8");

test("Backroom exposes only authenticated real device frames", async () => {
  const wrapper = await read("src/BackroomApp.tsx");
  const entry = await read("src/main.tsx");
  const devices = await read("src/BackroomDevicesApp.tsx");
  assert.match(wrapper, /BackroomDevicesApp/);
  assert.match(wrapper, /CloudApp/);
  assert.match(wrapper, /supabase\.auth\.getSession/);
  assert.match(wrapper, /onAuthStateChange/);
  assert.match(wrapper, /return <BackroomDevicesApp \/>/);
  assert.doesNotMatch(wrapper, /BackroomSimulatorApp|Browser runtime|browserView|br-mode-nav/);
  assert.match(entry, /isBackroom \? <BackroomApp \/>/);
  assert.doesNotMatch(entry, /BackroomSimulatorApp|Browser runtime/);
  assert.match(devices, /Device connections/);
  assert.match(devices, /Android phone/);
  assert.match(devices, /Computer/);
  assert.match(devices, /<BackroomAndroidControl/);
  assert.match(devices, /<BackroomDesktopControl/);
  assert.doesNotMatch(devices, /'phone'\s*\|\s*'desktop'\s*\|\s*'terminal'/);
  assert.doesNotMatch(devices, /Browser runtime|BackroomSimulatorApp/);
});
test("Switching groups clears prior device state and remounts active runtime controllers", async () => {
  const devices = await read("src/BackroomDevicesApp.tsx");
  assert.match(devices, /function changeRoom\(nextRoomId: string\)/);
  assert.match(devices, /roomIdRef\.current = nextRoomId/);
  assert.match(devices, /setDevices\(\[\]\)/);
  assert.match(devices, /setEvents\(\[\]\)/);
  assert.match(devices, /setSelectedDeviceId\(\x27\x27\)/);
  assert.match(devices, /setPairCode\(\x27\x27\)/);
  assert.match(devices, /setPairExpires\(\x27\x27\)/);
  assert.match(devices, /if \(roomIdRef\.current !== targetRoom\) return/);
  assert.match(devices, /BackroomAndroidControl key=\{roomId \+ ':' \+ activeDevice\.device_id\}/);
  assert.match(devices, /BackroomDesktopControl key=\{roomId\}/);
});

test("Device Frame refreshes visible device state without stale room overwrites", async () => {
  const devices = await read("src/BackroomDevicesApp.tsx");
  assert.match(devices, /setInterval\(poll, 20_000\)/);
  assert.match(devices, /document\.visibilityState !== 'visible'/);
  assert.match(devices, /requestId !== refreshRequestRef\.current/);
  assert.match(devices, /targetRoom !== roomIdRef\.current/);
  assert.match(devices, /function changeRoom\(nextRoomId: string\)/);
  assert.match(devices, /setDevices\(\[\]\)[\s\S]*?setEvents\(\[\]\)[\s\S]*?setSelectedDeviceId\(''\)[\s\S]*?setLastUpdatedAt\(null\)/);
  assert.match(devices, /roomIdRef\.current !== targetRoom/);
  assert.match(devices, /onChange=\{event => changeRoom\(event\.target\.value\)\}/);
  assert.match(devices, /if \(roomIdRef\.current === targetRoom\) setError/);
  assert.match(devices, /const targetRoom = roomIdRef\.current;[\s\S]*?refresh\(targetRoom\)\.catch/);
  assert.match(devices, /if \(roomIdRef\.current !== targetRoom\) return;[\s\S]*?window\.prompt/);
  assert.match(devices, /Device refresh failed\./);
  assert.match(devices, /const targetRoom = roomIdRef\.current;[\s\S]*?refresh\(targetRoom\)\.catch/);
  assert.match(devices, /if \(roomIdRef\.current !== targetRoom\) return/);
  assert.match(devices, /if \(roomIdRef\.current === targetRoom\) setNotice/);
  assert.match(devices, /lastUpdatedAt/);
  assert.match(devices, /Last seen ' \+ formatTime\(device\.last_seen_at\)/);
  assert.match(devices, /No device heartbeat yet/);
  assert.match(devices, /device\.status === 'active' \? 'Approved'/);
  assert.doesNotMatch(devices, /'Online'|>online</i);
});

test("Backroom frame layout contract excludes simulated screens and separates permissions", async () => {
  const ux = await read("docs/BACKROOM_DEVICE_FRAME_UX.md");
  const devices = await read("src/BackroomDevicesApp.tsx");
  const styles = await read("src/backroom-cloud.css");
  const android = await read("src/BackroomAndroidControl.tsx");
  assert.match(ux, /not a simulator/i);
  assert.match(ux, /screen share, touch, draft insertion and native Send remain separately authorized/i);
  assert.match(ux, /never enables native Send/);
  assert.match(devices, /AI-directed sending \/ native Off · On · Auto/);
  assert.match(android, /Insert draft/);
  assert.match(android, /Request touch control/);
});

test("Device Frame shows one selected Android phone at a time", async () => {
  const devices = await read("src/BackroomDevicesApp.tsx");
  assert.match(devices, /selectedDeviceId/);
  assert.match(devices, /activePhones\.length > 1/);
  assert.match(devices, /activePhones\.map/);
  assert.match(devices, /activePhones\.find/);
  assert.doesNotMatch(devices, /activeDevices\.flatMap/);
});

test("Device Frame renders the real live app surface without a decorative phone simulator", async () => {
  const devices = await read("src/BackroomDevicesApp.tsx");
  assert.match(devices, /<BackroomAndroidControl key=\{roomId \+ ':' \+ activeDevice\.device_id\} device=\{activeDevice\} roomId=\{roomId\}\/>/);
  assert.match(devices, /<BackroomDesktopControl key=\{roomId\} roomId=\{roomId\}\s*\/>/);
  assert.match(devices, /Original Android app screen/);
  assert.match(devices, /Original computer screen and terminal/);
  assert.doesNotMatch(devices, /br-cloud-phone|br-cloud-phone-notch|Selected apps/);
  assert.doesNotMatch(styles, /\.br-cloud-phone(?:[\s.#:{,]|$)|\.br-cloud-app-row|\.br-cloud-app-icon|\.br-cloud-capabilities|\.br-cloud-unavailable/);
  assert.doesNotMatch(devices, /'phone'\s*\|\s*'desktop'\s*\|\s*'terminal'/);
  assert.match(devices, /No approved Android phone/);
});

test("Windows computer-frame input requires exact Backroom-launched HWND and full-monitor identity", async () => {
  const native = await read("desktop-companion/src-tauri/src/lib.rs");
  const targeting = await read("desktop-companion/src-tauri/src/input_targeting.rs");
  const bridge = await read("desktop-companion/src/main.js");
  const frame = await read("src/BackroomDesktopControl.tsx");
  assert.match(native, /state\.launched_app_ids[\s\S]*get\(&app_id\)/);
  assert.match(native, /state\.desktop_processes[\s\S]*get_mut\(&process_id\)/);
  assert.match(native, /foreground_window_snapshot_for_process\(process_id\)/);
  assert.match(native, /window_binding: Some\(window_binding\)/);
  assert.match(native, /current\.process_id == binding\.process_id[\s\S]*current\.handle == binding\.handle[\s\S]*current\.class_name == binding\.class_name[\s\S]*current\.bounds == binding\.bounds/);
  assert.match(native, /fn validate_full_monitor_window_bounds/);
  assert.match(native, /fn capture_bounds[\s\S]*This screen session has no verified native application window binding; desktop input is view-only/);
  assert.match(native, /fn dispatch_input[\s\S]*capture_bounds\(&state, &geometry\)/);
  assert.match(targeting, /exactly one visible top-level window/);
  assert.match(targeting, /focused_handle/);
  assert.match(bridge, /appId/);
  assert.match(bridge, /foreground HWND, process identity and full-monitor window bounds match/);
  assert.match(frame, /foreground HWND \+ process \+ full-monitor bounds verified/);
  assert.match(frame, /launch the selected app from Backroom[\s\S]*make it fill the shared monitor/);
});

test("Android Phone Frame wires a consented WebRTC stream and a separate touch grant", async () => {
  const control = await read("src/BackroomAndroidControl.tsx");
  const phone = await read("src/BackroomDevicesApp.tsx");
  assert.match(phone, /import BackroomAndroidControl/);
  assert.ok(phone.includes("BackroomAndroidControl key={roomId + ':' + activeDevice.device_id} device={activeDevice}") && phone.includes("roomId={roomId}"));
  assert.match(control, /RTCPeerConnection/);
  assert.ok(control.includes("addTransceiver('video', { direction: 'recvonly' })"));
  assert.match(control, /android\/session-start/);
  assert.match(control, /android\/command/);
  assert.match(control, /request_control/);
  assert.match(control, /kind: 'touch'/);
  assert.match(control, /gesture, from:/);
  assert.match(control, /waitForIceGatheringComplete/);
  assert.match(control, /whole display/);
  assert.match(control, /not an isolated virtual copy/);
});

test("Android composer selection binds one real non-password accessibility node before typing", async () => {
  const control = await read("src/BackroomAndroidControl.tsx");
  const service = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidTouchAccessibilityService.kt");
  const screen = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidScreenShareService.kt");
  const keyboard = await read("android-companion/app/src/main/java/app/rubminds/companion/DraftInputMethodService.kt");
  const policy = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidComposerTargetPolicy.kt");
  assert.match(control, /Drag-select typing area/);
  assert.match(control, /createNormalizedDragSelection/);
  assert.match(control, /kind: 'select_composer_target'/);
  assert.match(control, /composer_target_ack/);
  assert.match(control, /targetId: selectedTargetId/);
  assert.match(screen, /select_composer_target/);
  assert.match(screen, /clear_composer_target/);
  assert.match(screen, /insertRemoteText\(sessionId, appPackage, targetId, text\)/);
  assert.match(service, /root\.findFocus\(AccessibilityNodeInfo\.FOCUS_INPUT\)/);
  assert.match(service, /node\.isEditable/);
  assert.match(service, /node\.isPassword/);
  assert.match(service, /MAX_COMPOSER_TREE_NODES = 160/);
  assert.doesNotMatch(service, /node\.text|node\.contentDescription|node\.getText\(/);
  assert.match(keyboard, /isSelectedComposerFocused\(sessionId, packageName, targetId\)/);
  assert.match(policy, /multiple_editable_fields_in_selection/);
  assert.match(policy, /MIN_NODE_COVERAGE/);
});


test("Android composer selection and Send recheck expose only a stable digest and detect conversation switches", async () => {
  const control = await read("src/BackroomAndroidControl.tsx");
  const screen = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidScreenShareService.kt");
  const service = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidTouchAccessibilityService.kt");
  const policy = await read("android-companion/app/src/main/java/app/rubminds/companion/AndroidComposerTargetPolicy.kt");
  const provider = await read("android-companion/app/src/main/java/app/rubminds/companion/ProviderConversationIdentity.kt");
  assert.match(policy, /providerConversationIdentityDigest: String\? = null/);
  assert.match(service, /ProviderConversationIdentityResolver\.resolve\(packageName, root\)/);
  assert.match(service, /sameBoundConversation/);
  assert.match(screen, /providerConversationIdentityDigest/);
  // The provider digest is deliberately kept inside Android. WebRTC exposes only
  // boolean availability/match signals; the browser must never receive the digest.
  assert.match(control, /providerConversationIdentityAvailable/);
  assert.match(control, /providerConversationIdentityMatchesSelection/);
  assert.match(control, /Only a boolean capability result crosses WebRTC/);
  assert.doesNotMatch(control, /providerConversationIdentityDigestRef|recheckedProviderDigest/);
  assert.match(control, /Native wake is blocked; draft insertion remains available/);
  assert.match(provider, /private val adapters: Map<String, ProviderConversationIdentityAdapter> = emptyMap\(\)/);
  assert.doesNotMatch(screen, /stableConversationId|activeConversationStableId/);
});

test("Android touch-control requests have a bounded pending state and exact request correlation", async () => {
  const control = await read("src/BackroomAndroidControl.tsx");
  assert.match(control, /pendingControlRequestRef/);
  assert.match(control, /controlRequestTimerRef/);
  assert.match(control, /45_000/);
  assert.ok(control.includes("payload.requestId !== pendingControlRequestRef.current"));
  assert.ok(control.includes("pendingControlRequestRef.current === requestId"));
});
