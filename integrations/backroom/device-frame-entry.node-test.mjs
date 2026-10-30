import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL("../../" + path, import.meta.url), "utf8");

test("Backroom preserves the managed simulator and adds connected devices as a peer view", async () => {
  const wrapper = await read("src/BackroomApp.tsx");
  const simulator = await read("src/BackroomSimulatorApp.tsx");
  const devices = await read("src/BackroomDevicesApp.tsx");
  assert.match(wrapper, /BackroomSimulatorApp/);
  assert.match(wrapper, /BackroomDevicesApp/);
  assert.match(wrapper, /devices\) params\.set\('devices', '1'\)/);
  assert.match(simulator, /LiveBrowserPreview/);
  assert.match(simulator, /refreshBrowserInventory/);
  assert.match(simulator, /Add a discovered app/);
  assert.match(devices, /Connected runtimes/);
});

test("the Android app list never claims that inventory is a running virtual app", async () => {
  const devices = await read("src/BackroomDevicesApp.tsx");
  assert.match(devices, /Separate app data \/ virtualization/);
  assert.match(devices, /Live screen and touch control/);
  assert.match(devices, /Desktop runtime not connected/);
  assert.match(devices, /Terminal runtime not connected/);
  assert.match(devices, /selected app metadata is synced/);
});
