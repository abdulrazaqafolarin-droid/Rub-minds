#!/usr/bin/env node
/**
 * End-to-end test of Backroom device pairing and authorization against the
 * disposable local Supabase stack only. Never points at production.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

const apiUrl = process.env.LOCAL_SUPABASE_URL;
const anonKey = process.env.LOCAL_SUPABASE_ANON_KEY;
const serviceKey = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;
assert.ok(apiUrl && anonKey && serviceKey, "local Supabase URL, anon key and service-role key are required");
assert.match(apiUrl, /^http:\/\/(?:127\.0\.0\.1|localhost):54321$/, "device E2E must only target the local Supabase stack");

const adminHeaders = {
  apikey: serviceKey,
  Authorization: "Bearer " + serviceKey,
  "Content-Type": "application/json",
};
const anonHeaders = {
  apikey: anonKey,
  Authorization: "Bearer " + anonKey,
  "Content-Type": "application/json",
};

async function decode(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; }
  catch { return text; }
}
async function adminRequest(path, init = {}) {
  const response = await fetch(apiUrl + path, {
    ...init,
    headers: { ...adminHeaders, ...(init.headers ?? {}) },
  });
  const body = await decode(response);
  assert.ok(response.ok, path + " failed (" + response.status + "): " + JSON.stringify(body));
  return body;
}
async function userRequest(path, accessToken, init = {}) {
  const response = await fetch(apiUrl + path, {
    ...init,
    headers: {
      ...anonHeaders,
      Authorization: "Bearer " + accessToken,
      ...(init.headers ?? {}),
    },
  });
  const body = await decode(response);
  return { response, body };
}
async function createUser(email) {
  return await adminRequest("/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({
      email,
      password: "Local-Backroom-Device-Password-942!x",
      email_confirm: true,
    }),
  });
}
async function signIn(email) {
  const response = await fetch(apiUrl + "/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: anonHeaders,
    body: JSON.stringify({ email, password: "Local-Backroom-Device-Password-942!x" }),
  });
  const body = await decode(response);
  assert.ok(response.ok && body?.access_token, "local test user sign-in failed: " + JSON.stringify(body));
  return body.access_token;
}
async function edge(action, fields, bearer) {
  const response = await fetch(apiUrl + "/functions/v1/backroom-device", {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: "Bearer " + bearer,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action, ...fields }),
  });
  return { response, body: await decode(response) };
}
function expectStatus(result, status, label) {
  assert.equal(result.response.status, status,
    label + " expected HTTP " + status + ", got " + result.response.status + ": " + JSON.stringify(result.body));
}

const ownerEmail = "rub-minds-backroom-device-owner@example.test";
const memberEmail = "rub-minds-backroom-device-member@example.test";
const owner = await createUser(ownerEmail);
const member = await createUser(memberEmail);
const ownerToken = await signIn(ownerEmail);
const memberToken = await signIn(memberEmail);

const createRoom = await userRequest("/rest/v1/rpc/create_room_with_owner", ownerToken, {
  method: "POST",
  body: JSON.stringify({
    room_title: "Local Backroom device E2E",
    room_objective: "Disposable pairing, inventory, group history and revoke test",
  }),
});
assert.ok(createRoom.response.ok, "could not create test group: " + JSON.stringify(createRoom.body));
const roomId = createRoom.body;
assert.match(roomId, /^[0-9a-f-]{36}$/i, "create_room_with_owner must return a room UUID");

const pairing = await edge("pair/create", { roomId, deviceLabel: "CI Android 14 phone" }, ownerToken);
expectStatus(pairing, 201, "create pairing");
assert.equal(pairing.body.ok, true);
assert.ok(Date.parse(pairing.body.expiresAt) > Date.now(), "pairing expiry must be in the future");
assert.ok(Date.parse(pairing.body.expiresAt) <= Date.now() + 5 * 60 * 1000 + 5000,
  "pairing code must expire within five minutes");

const deviceId = randomUUID();
const deviceToken = randomBytes(32).toString("hex");
const claimFields = {
  pairingCode: pairing.body.pairingCode,
  deviceId,
  deviceLabel: "CI Android 14 phone",
  osVersion: "14",
  appVersion: "0.2.0",
};
const claim = await edge("pair/claim", claimFields, deviceToken);
expectStatus(claim, 201, "claim pairing");
assert.equal(claim.body.status, "pending");
assert.equal(claim.body.ownerApprovalRequired, true);
assert.doesNotMatch(JSON.stringify(claim.body), new RegExp(deviceToken), "claim response must not reveal the device credential");

const replay = await edge("pair/claim", claimFields, deviceToken);
expectStatus(replay, 409, "pairing replay");
assert.equal(replay.body.reason, "pairing_expired_or_used");

const pendingStatus = await edge("device/status", {}, deviceToken);
expectStatus(pendingStatus, 200, "pending device status");
assert.equal(pendingStatus.body.status, "pending");

const memberInvite = await userRequest("/rest/v1/rpc/create_dual_room_invite", ownerToken, {
  method: "POST",
  body: JSON.stringify({
    target_room: roomId,
    valid_hours: 1,
    allowed_uses: 1,
    allow_ai_participants: false,
    allowed_ai_uses: 0,
  }),
});
assert.ok(memberInvite.response.ok, "could not create member invitation: " + JSON.stringify(memberInvite.body));
const memberJoin = await userRequest("/rest/v1/rpc/redeem_room_invite", memberToken, {
  method: "POST",
  body: JSON.stringify({ invite_token: memberInvite.body }),
});
assert.ok(memberJoin.response.ok, "could not redeem member invitation: " + JSON.stringify(memberJoin.body));
assert.equal(memberJoin.body, roomId);

const memberCannotPair = await edge("pair/create", { roomId, deviceLabel: "Unauthorized member phone" }, memberToken);
expectStatus(memberCannotPair, 403, "member pairing denial");
assert.equal(memberCannotPair.body.reason, "room_owner_required");

const approval = await edge("owner/approve", { deviceId, roomId }, ownerToken);
expectStatus(approval, 200, "owner approval");
assert.equal(approval.body.status, "active");

const activeStatus = await edge("device/status", {}, deviceToken);
expectStatus(activeStatus, 200, "active device status");
assert.equal(activeStatus.body.status, "active");
assert.equal(activeStatus.body.capabilities?.appDiscovery, true);
assert.equal(activeStatus.body.capabilities?.embeddedVirtualApp, false);
assert.equal(activeStatus.body.capabilities?.liveScreen, false);
assert.equal(activeStatus.body.capabilities?.touchControl, false);

const app = {
  packageName: "com.example.backroomci",
  label: "Backroom CI Sample",
  signingCertificateSha256: "a".repeat(64),
  versionName: "1.0.0",
  draftInsertionAllowed: false,
};
const inventory = await edge("device/inventory", { apps: [app] }, deviceToken);
expectStatus(inventory, 200, "inventory sync");
assert.equal(inventory.body.synced, 1);

const appOpened = await edge("device/event", {
  eventType: "app_open_requested",
  packageName: app.packageName,
}, deviceToken);
expectStatus(appOpened, 201, "device activity event");

const ownerDevices = await edge("room/devices", { roomId }, ownerToken);
expectStatus(ownerDevices, 200, "owner device inventory");
const listedDevice = ownerDevices.body.devices.find(item => item.device_id === deviceId);
assert.ok(listedDevice, "owner must see the paired device");
assert.equal(listedDevice.status, "active");
assert.equal(listedDevice.apps.length, 1);
assert.equal(listedDevice.apps[0].package_name, app.packageName);
assert.doesNotMatch(JSON.stringify(ownerDevices.body), /token_digest|credential_digest|service_role/i,
  "device listing must not expose private credential fields");

const memberDevices = await edge("room/devices", { roomId }, memberToken);
expectStatus(memberDevices, 200, "member device inventory");
assert.ok(memberDevices.body.devices.some(item => item.device_id === deviceId),
  "group members must be able to view the selected app inventory");

const memberEvents = await edge("room/events", { roomId }, memberToken);
expectStatus(memberEvents, 200, "member activity history");
const eventTypes = memberEvents.body.events.map(item => item.event_type);
assert.ok(eventTypes.includes("app_added"), "inventory additions must be visible in group history");
assert.ok(eventTypes.includes("app_open_requested"), "device actions must be visible in group history");

const anonTableRead = await fetch(apiUrl + "/rest/v1/backroom_devices?select=device_id", {
  headers: anonHeaders,
});
assert.notEqual(anonTableRead.status, 200, "private device registry must not be directly readable by anon clients");

const revoke = await edge("owner/revoke", { deviceId, roomId }, ownerToken);
expectStatus(revoke, 200, "owner device revoke");
assert.equal(revoke.body.status, "revoked");

const revokedStatus = await edge("device/status", {}, deviceToken);
expectStatus(revokedStatus, 200, "revoked device status");
assert.equal(revokedStatus.body.status, "revoked");

const blockedInventory = await edge("device/inventory", { apps: [app] }, deviceToken);
expectStatus(blockedInventory, 401, "revoked device inventory denial");

const historyAfterRevoke = await edge("room/events", { roomId }, memberToken);
expectStatus(historyAfterRevoke, 200, "post-revoke group history");
assert.ok(historyAfterRevoke.body.events.some(item => item.event_type === "device_revoked"),
  "revocation must be retained in group history");
const devicesAfterRevoke = await edge("room/devices", { roomId }, memberToken);
expectStatus(devicesAfterRevoke, 200, "post-revoke device list");
const revokedDevice = devicesAfterRevoke.body.devices.find(item => item.device_id === deviceId);
assert.equal(revokedDevice?.status, "revoked");
assert.deepEqual(revokedDevice?.apps, [], "revocation must remove the live app inventory");

console.log("Local Backroom pairing, replay protection, owner approval, member visibility, selected-app inventory, activity history and revocation passed:", roomId, deviceId);
