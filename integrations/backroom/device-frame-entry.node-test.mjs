import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL("../../" + path, import.meta.url), "utf8");

test("Backroom uses the cloud Device Frame and gates direct links with Rub Minds sign-in", async () => {
  const wrapper = await read("src/BackroomApp.tsx");
  const entry = await read("src/main.tsx");
  const devices = await read("src/BackroomDevicesApp.tsx");
  assert.match(wrapper, /BackroomDevicesApp/);
  assert.match(wrapper, /CloudApp/);
  assert.match(wrapper, /supabase\.auth\.getSession/);
  assert.match(wrapper, /onAuthStateChange/);
  assert.match(wrapper, /BackroomSimulatorApp/);
  assert.match(wrapper, /browserView/);
  assert.match(wrapper, /backroomViewHref/);
  assert.match(wrapper, /Browser runtime/);
  assert.doesNotMatch(wrapper, /localhost|127\.0\.0\.1|host-server/);
  assert.match(entry, /isBackroom \? <BackroomApp \/>/);
  assert.match(devices, /Connected runtimes/);
  const browser = await read("src/BackroomSimulatorApp.tsx");
  assert.match(devices, /Phone apps/);
  assert.match(devices, /Desktop apps/);
  assert.match(devices, /Terminal/);
  assert.match(devices, /outbound HTTPS/);
  assert.match(browser, /LiveBrowserPreview/);
  assert.ok(!browser.includes('function Preview('));
  for (const demoOnlyCopy of ['DEMO · NOT LIVE', 'Select demo region', 'Simulated ', 'workspace placeholder']) assert.ok(!browser.includes(demoOnlyCopy), 'legacy demo content remains: ' + demoOnlyCopy);
  assert.ok(browser.includes("surface === 'browser_tab' && typeof s.pageId === 'string'"));
  assert.match(browser, /verified app connection/);

  assert.match(browser, /refreshBrowserInventory/);
  assert.match(browser, /select-region/);
  assert.match(browser, /browser_tab/);
  assert.match(devices, /No localhost server or phone port bridge/);
});

test("switching browser rooms preserves the authenticated Backroom browser route", async () => {
  const browser = await read("src/BackroomSimulatorApp.tsx");
  assert.match(browser, /new URLSearchParams\(location\.search\)/);
  assert.match(browser, /params\.set\('backroom', '1'\)/);
  assert.match(browser, /params\.set\('room', e\.target\.value\)/);
  assert.match(browser, /location\.pathname \+ '\?' \+ params\.toString\(\)/);
});

test("Device Frame shows one selected phone at a time", async () => {
  const devices = await read("src/BackroomDevicesApp.tsx");
  assert.match(devices, /selectedDeviceId/);
  assert.match(devices, /activeDevices\.length > 1/);
  assert.match(devices, /activeDevice\.apps\.map/);
  assert.doesNotMatch(devices, /devices\.filter\(device => device\.status === 'active'\)\.flatMap/);
});

test("Device Frame never claims inventory is a running virtual app", async () => {
  const devices = await read("src/BackroomDevicesApp.tsx");
  assert.match(devices, /Separate app data \/ virtualization/);
  assert.ok(devices.includes("Live original app stream and touch"));
  assert.match(devices, /<BackroomAndroidControl/);
  assert.match(devices, /import BackroomDesktopControl from '.\/BackroomDesktopControl'/);
  assert.ok(devices.includes('<BackroomDesktopControl roomId={roomId}/>'));
  assert.doesNotMatch(devices, /Desktop runtime not connected|Terminal runtime not connected/);
  assert.match(devices, /surface === 'phone' && <div className="br-cloud-capabilities">/);

  assert.match(devices, /selected app metadata is synced/);
});

test("Android Phone Frame wires a consented WebRTC stream and a separate touch grant", async () => {
  const control = await read("src/BackroomAndroidControl.tsx");
  const phone = await read("src/BackroomDevicesApp.tsx");
  assert.match(phone, /import BackroomAndroidControl/);
  assert.ok(phone.includes("BackroomAndroidControl device={activeDevice}") && phone.includes("roomId={roomId}"));
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

test("device-frame connector clears stale state and ignores responses from a previous runtime", async () => {
  const connector = await read("src/BackroomFrameAIConnector.tsx");
  assert.match(connector, /useLayoutEffect, useMemo, useRef/);
  assert.match(connector, /const operationEpoch = useRef\(0\)/);

  const frameReset = connector.match(
    /useLayoutEffect\(\(\) => \{([\s\S]*?)\}, \[deviceId, ready, roomId, runtimeSessionId, surface\]\)/
  );
  assert.ok(frameReset, "frame identity changes must synchronously invalidate the previous UI state");
  for (const state of [
    "operationEpoch.current += 1",
    "setCandidates([])",
    "setParticipantId('')",
    "setBinding(null)",
    "setChallenge(null)",
    "setBusy(false)",
    "setError('')",
    "setNotice('')",
  ]) assert.ok(frameReset[1].includes(state), "frame reset is missing " + state);

  assert.equal(
    (connector.match(/const requestEpoch = \+\+operationEpoch.current/g) || []).length,
    3,
    "refresh, challenge creation and revoke must each own a request epoch",
  );
  assert.ok(
    (connector.match(/requestEpoch !== operationEpoch.current/g) || []).length >= 3,
    "late responses must not overwrite state for a newer frame or operation",
  );
  assert.match(connector, /result\.participantId !== selectedCandidate\.participantId/);
  assert.match(connector, /result\.surface !== surface/);
  assert.match(connector, /validUuid/);
  assert.match(connector, /validNonce/);
  assert.match(connector, /expiresAtMs <= Date\.now\(\)/);
});
