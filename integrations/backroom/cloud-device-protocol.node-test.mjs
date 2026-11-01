import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validatePairClaim, validateSelectedApps, isDeviceControlAvailable, sanitizeDeviceEvent, DEVICE_CAPABILITIES_V1 } from "./cloud-device-protocol.mjs";

const uuid = "6f3e31c1-2c72-4e3f-a8d3-30b3fcb72a12";
const hex = "a".repeat(64);
const app = { packageName:"com.example.chat", label:"Chat", signingCertificateSha256:hex, versionName:"1.2.3", draftInsertionAllowed:false };

const initialPairingMigration = await readFile(
  new URL("../../supabase/migrations/20261030110000_backroom_cloud_devices.sql", import.meta.url),
  "utf8",
);
const pairingRepairMigration = await readFile(
  new URL("../../supabase/migrations/20261101173500_fix_backroom_device_pairing_output_column_ambiguity.sql", import.meta.url),
  "utf8",
);

test("pairing RPC qualifies output-column names to avoid PL/pgSQL ambiguity", () => {
  const requiredFragments = [
    "from public.backroom_devices as existing_device",
    "where existing_device.token_digest = p_token_digest",
    "where existing_device.device_id = p_device_id",
    "from public.rooms as room",
    "room.owner_id = v_pairing.owner_id",
    "existing_device.owner_id = v_pairing.owner_id",
    "set search_path = ''",
    "to service_role",
    "from public, anon, authenticated",
  ];
  for (const sql of [initialPairingMigration, pairingRepairMigration]) {
    for (const fragment of requiredFragments) {
      assert.ok(sql.includes(fragment), "pairing migration is missing qualified SQL fragment: " + fragment);
    }
  }
});;

test("pair claim accepts only bounded typed credentials and identity", () => {
  assert.equal(validatePairClaim({pairingCode:hex,deviceId:uuid,deviceLabel:"My phone",osVersion:"14",appVersion:"0.2"},"b".repeat(64)),true);
  assert.equal(validatePairClaim({pairingCode:hex,deviceId:uuid,deviceLabel:"x".repeat(81),osVersion:"14",appVersion:"0.2"},"b".repeat(64)),false);
  assert.equal(validatePairClaim({pairingCode:hex,deviceId:uuid,deviceLabel:"Phone",osVersion:"14",appVersion:"0.2",ownerId:uuid},"b".repeat(64)),false);
});
test("inventory accepts a bounded unique selected-app list only", () => {
  assert.equal(validateSelectedApps([app]),true);
  assert.equal(validateSelectedApps([app,app]),false);
  assert.equal(validateSelectedApps([{...app,privateData:"secret"}]),false);
  assert.equal(validateSelectedApps([{...app,signingCertificateSha256:"bad"}]),false);
  assert.equal(validateSelectedApps(Array.from({length:101},(_,i)=>({...app,packageName:"com.example.app"+i}))),false);
});
test("unsupported execution capabilities never appear available by assumption", () => {
  assert.equal(isDeviceControlAvailable({status:"pending",capabilities:DEVICE_CAPABILITIES_V1},"touchControl"),false);
  assert.equal(isDeviceControlAvailable({status:"active",capabilities:DEVICE_CAPABILITIES_V1},"touchControl"),false);
  assert.equal(isDeviceControlAvailable({status:"active",capabilities:{touchControl:true}},"touchControl"),true);
});
test("activity events reject arbitrary payloads and secret-bearing fields", () => {
  assert.deepEqual(sanitizeDeviceEvent({action:"device/event",eventType:"app_open_requested",packageName:"com.example.chat"}),{eventType:"app_open_requested",packageName:"com.example.chat"});
  assert.equal(sanitizeDeviceEvent({eventType:"app_open_requested",packageName:"com.example.chat",text:"private prompt"}),null);
  assert.equal(sanitizeDeviceEvent({eventType:"shell_command",packageName:"com.example.chat"}),null);
});
test("capability contract explicitly distinguishes inventory from virtualization and control", () => {
  assert.equal(DEVICE_CAPABILITIES_V1.appDiscovery,true);
  assert.equal(DEVICE_CAPABILITIES_V1.separateAppData,false);
  assert.equal(DEVICE_CAPABILITIES_V1.embeddedVirtualApp,false);
  assert.equal(DEVICE_CAPABILITIES_V1.liveScreen,false);
});
