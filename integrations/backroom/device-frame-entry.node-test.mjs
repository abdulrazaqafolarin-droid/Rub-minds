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
  assert.doesNotMatch(wrapper, /BackroomSimulatorApp|localhost|127\.0\.0\.1|host-server/);
  assert.match(entry, /isBackroom \? <BackroomApp \/>/);
  assert.match(devices, /Connected runtimes/);
  assert.match(devices, /Phone apps/);
  assert.match(devices, /Desktop apps/);
  assert.match(devices, /Terminal/);
  assert.match(devices, /outbound HTTPS/);
  assert.match(devices, /No localhost server or phone port bridge/);
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
  assert.match(devices, /Live screen and touch control/);
  assert.match(devices, /Desktop runtime not connected/);
  assert.match(devices, /Terminal runtime not connected/);
  assert.match(devices, /selected app metadata is synced/);
});
