import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL("../../" + path, import.meta.url), "utf8");

test("Backroom opens the cloud Device Frame directly; localhost simulator is not a user-facing route", async () => {
  const wrapper = await read("src/BackroomApp.tsx");
  const devices = await read("src/BackroomDevicesApp.tsx");
  assert.match(wrapper, /BackroomDevicesApp/);
  assert.doesNotMatch(wrapper, /BackroomSimulatorApp|localhost|127\.0\.0\.1|host-server/);
  assert.match(devices, /Connected runtimes/);
  assert.match(devices, /Phone apps/);
  assert.match(devices, /Desktop apps/);
  assert.match(devices, /Terminal/);
  assert.match(devices, /outbound HTTPS/);
  assert.match(devices, /No localhost server or phone port bridge/);
});

test("Device Frame never claims inventory is a running virtual app", async () => {
  const devices = await read("src/BackroomDevicesApp.tsx");
  assert.match(devices, /Separate app data \/ virtualization/);
  assert.match(devices, /Live screen and touch control/);
  assert.match(devices, /Desktop runtime not connected/);
  assert.match(devices, /Terminal runtime not connected/);
  assert.match(devices, /selected app metadata is synced/);
});
