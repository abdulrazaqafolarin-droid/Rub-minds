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
  assert.ok(devices.includes("Live app stream and tap/swipe control"));
  assert.match(devices, /<BackroomAndroidControl/);
  assert.match(devices, /Desktop runtime not connected/);
  assert.match(devices, /Terminal runtime not connected/);
  assert.match(devices, /selected app metadata is synced/);
});

test("Android Phone Frame wires a consented WebRTC stream and a separate touch grant", async () => {
  const control = await read("src/BackroomAndroidControl.tsx");
  const phone = await read("src/BackroomDevicesApp.tsx");
  assert.match(phone, /import BackroomAndroidControl/);
  assert.ok(phone.includes("BackroomAndroidControl device={activeDevice}") && phone.includes("roomId={roomId}"));
  assert.match(control, /RTCPeerConnection/);
  assert.match(control, /addTransceiver\\('video', \\{ direction: 'recvonly' \\}\\)/);
  assert.match(control, /android\/session-start/);
  assert.match(control, /android\/command/);
  assert.match(control, /request_control/);
  assert.match(control, /kind: 'touch'/);
  assert.match(control, /gesture, from:/);
  assert.match(control, /waitForIceGatheringComplete/);
  assert.match(control, /whole display/);
  assert.match(control, /not an isolated virtual copy/);
});

test("Android touch-control requests have a bounded pending state and exact request correlation", async () => {
  const control = await read("src/BackroomAndroidControl.tsx");
  assert.match(control, /pendingControlRequestRef/);
  assert.match(control, /controlRequestTimerRef/);
  assert.match(control, /45_000/);
  assert.ok(control.includes("payload.requestId !== pendingControlRequestRef.current"));
  assert.ok(control.includes("pendingControlRequestRef.current === requestId"));
});
