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

// Desktop registration is bound to the authenticated Rub Minds account:
// no localhost URL, copied pairing code or Android-style claim flow.
const desktopDeviceId = randomUUID();
const desktopRegistrationFields = {
  deviceId: desktopDeviceId,
  deviceLabel: "CI Windows workstation",
  platform: "windows",
  osVersion: "Windows 11 CI",
  appVersion: "0.3.0",
  roomId,
  devicePublicKey: randomBytes(32).toString("hex"),
};
const desktopRegistration = await edge("desktop/register", desktopRegistrationFields, ownerToken);
expectStatus(desktopRegistration, 201, "account-authenticated desktop registration");
assert.equal(desktopRegistration.body.status, "active");
assert.equal(desktopRegistration.body.deviceId, desktopDeviceId);
assert.match(desktopRegistration.body.deviceToken, /^[a-f0-9]{64}$/);
assert.equal(desktopRegistration.body.capabilities?.appDiscovery, true);
assert.equal(desktopRegistration.body.capabilities?.liveScreen, false);
assert.equal(desktopRegistration.body.capabilities?.desktopControl, false);
assert.equal(desktopRegistration.body.capabilities?.terminalControl, false);
assert.equal(Object.hasOwn(desktopRegistration.body, "pairingCode"), false);
const desktopToken = desktopRegistration.body.deviceToken;

const desktopStatus = await edge("device/status", {}, desktopToken);
expectStatus(desktopStatus, 200, "registered desktop device status");
assert.equal(desktopStatus.body.deviceId, desktopDeviceId);
assert.equal(desktopStatus.body.status, "active");

const desktopSessionId = randomUUID();
const desktopSessionExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
await adminRequest("/rest/v1/backroom_desktop_sessions", {
  method: "POST",
  headers: { Prefer: "return=minimal" },
  body: JSON.stringify({
    session_id: desktopSessionId,
    device_id: desktopDeviceId,
    room_id: roomId,
    requested_by: owner.id,
    session_type: "terminal",
    status: "active",
    expires_at: desktopSessionExpiry,
  }),
});
const closedDesktopSession = await edge("desktop/session-close", {
  roomId, sessionId: desktopSessionId,
}, desktopToken);
expectStatus(closedDesktopSession, 200, "device-authenticated desktop session close");
assert.equal(closedDesktopSession.body.status, "stopped");
assert.equal(closedDesktopSession.body.closed, true);
const closedDesktopSessionRow = await adminRequest(
  "/rest/v1/backroom_desktop_sessions?select=status&session_id=eq." + desktopSessionId
);
assert.equal(closedDesktopSessionRow.length, 1);
assert.equal(closedDesktopSessionRow[0].status, "stopped");
const repeatedDesktopSessionClose = await edge("desktop/session-close", {
  roomId, sessionId: desktopSessionId,
}, desktopToken);
expectStatus(repeatedDesktopSessionClose, 200, "idempotent desktop session close");
assert.equal(repeatedDesktopSessionClose.body.closed, false);
assert.equal(repeatedDesktopSessionClose.body.status, "unchanged");
const invalidDesktopSessionClose = await edge("desktop/session-close", {
  roomId, sessionId: "not-a-session",
}, desktopToken);
expectStatus(invalidDesktopSessionClose, 400, "invalid desktop session close rejection");

const abandonedDesktopSessionId = randomUUID();
await adminRequest("/rest/v1/backroom_desktop_sessions", {
  method: "POST",
  headers: { Prefer: "return=minimal" },
  body: JSON.stringify({
    session_id: abandonedDesktopSessionId,
    device_id: desktopDeviceId,
    room_id: roomId,
    requested_by: owner.id,
    session_type: "screen",
    status: "active",
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }),
});
const memberCannotAbandonOwnerSession = await edge("desktop/session-abandon", {
  deviceId: desktopDeviceId, roomId, sessionId: abandonedDesktopSessionId,
  requestId: randomUUID(), issuedAt: Date.now(),
}, memberToken);
expectStatus(memberCannotAbandonOwnerSession, 404, "group member cannot abandon another user's session");
const protectedSession = await adminRequest(
  "/rest/v1/backroom_desktop_sessions?select=status&session_id=eq." + abandonedDesktopSessionId
);
assert.equal(protectedSession[0]?.status, "active");
const ownerAbandon = await edge("desktop/session-abandon", {
  deviceId: desktopDeviceId, roomId, sessionId: abandonedDesktopSessionId,
  requestId: randomUUID(), issuedAt: Date.now(),
}, ownerToken);
expectStatus(ownerAbandon, 200, "request owner session abandonment");
assert.equal(ownerAbandon.body.closed, true);
const ownerAbandonReplay = await edge("desktop/session-abandon", {
  deviceId: desktopDeviceId, roomId, sessionId: abandonedDesktopSessionId,
  requestId: randomUUID(), issuedAt: Date.now(),
}, ownerToken);
expectStatus(ownerAbandonReplay, 200, "idempotent session abandonment");
assert.equal(ownerAbandonReplay.body.closed, false);

const repeatStopAfterLocalClose = await edge("desktop/command", {
  deviceId: desktopDeviceId,
  roomId,
  requestId: randomUUID(),
  issuedAt: Date.now(),
  command: "stop_session",
  details: { sessionId: desktopSessionId },
}, ownerToken);
expectStatus(repeatStopAfterLocalClose, 202, "idempotent stop after the native device already closed the session");
assert.equal(repeatStopAfterLocalClose.body.command, "stop_session");

const selectedDesktopApp = {
  appId: randomUUID(),
  label: "Backroom CI Desktop App",
  sha256: "c".repeat(64),
};
const desktopInventory = await edge("desktop/inventory", { apps: [selectedDesktopApp] }, desktopToken);
expectStatus(desktopInventory, 200, "desktop selected-app inventory sync");
assert.equal(desktopInventory.body.synced, 1);
const invalidDesktopInventory = await edge("desktop/inventory", {
  apps: [{ ...selectedDesktopApp, executablePath: "C:\\\\Users\\\\Private\\\\app.exe" }]
}, desktopToken);
expectStatus(invalidDesktopInventory, 400, "reject executable paths from desktop inventory");

const memberDesktopRegistration = await edge("desktop/register", {
  ...desktopRegistrationFields, deviceId: randomUUID()
}, memberToken);
expectStatus(memberDesktopRegistration, 403, "non-owner desktop registration denial");
assert.equal(memberDesktopRegistration.body.reason, "room_owner_required");

const duplicateDesktopRegistration = await edge("desktop/register", desktopRegistrationFields, ownerToken);
expectStatus(duplicateDesktopRegistration, 409, "duplicate desktop device identity rejection");

const memberCannotRevokeDesktop = await edge("owner/revoke", {
  deviceId: desktopDeviceId, roomId
}, memberToken);
expectStatus(memberCannotRevokeDesktop, 404, "non-owner desktop revoke denial");

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

const androidSessionId = randomUUID();
await adminRequest("/rest/v1/backroom_desktop_sessions", {
  method: "POST",
  headers: { Prefer: "return=minimal" },
  body: JSON.stringify({
    session_id: androidSessionId,
    device_id: deviceId,
    room_id: roomId,
    requested_by: owner.id,
    session_type: "screen",
    status: "active",
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  }),
});
const crossDeviceClose = await edge("desktop/session-close", {
  roomId, sessionId: androidSessionId,
}, desktopToken);
expectStatus(crossDeviceClose, 200, "cross-device session close no-op");
assert.equal(crossDeviceClose.body.closed, false);
const stillActiveAndroidSession = await adminRequest(
  "/rest/v1/backroom_desktop_sessions?select=status&session_id=eq." + androidSessionId
);
assert.equal(stillActiveAndroidSession[0]?.status, "active",
  "a desktop credential must never close another device's session");

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

// Account-authenticated desktop: active registration and secure digest-backed token.
const ownerDesktopInventory = await edge("room/devices", { roomId }, ownerToken);
expectStatus(ownerDesktopInventory, 200, "owner desktop device listing");
const ownerDesktopRecord = ownerDesktopInventory.body.devices.find(item => item.device_id === desktopDeviceId);
assert.equal(ownerDesktopRecord?.status, "active");
assert.equal(ownerDesktopRecord?.platform, "windows");
assert.equal(ownerDesktopRecord?.desktopApps?.length, 1);
assert.equal(ownerDesktopRecord?.desktopApps?.[0]?.app_label, selectedDesktopApp.label);
assert.equal(ownerDesktopRecord?.desktopApps?.[0]?.executable_sha256, selectedDesktopApp.sha256);
assert.doesNotMatch(JSON.stringify(ownerDesktopInventory.body), new RegExp(desktopToken),
  "device token must never appear in an owner device listing");
assert.doesNotMatch(JSON.stringify(ownerDesktopInventory.body), /token_digest|device_public_key/i,
  "device credentials and public key must not be exposed by the public listing");

const memberDesktopInventory = await edge("room/devices", { roomId }, memberToken);
expectStatus(memberDesktopInventory, 200, "member desktop device visibility");
assert.ok(memberDesktopInventory.body.devices.some(item => item.device_id === desktopDeviceId));
const memberDesktopRecord = memberDesktopInventory.body.devices.find(item => item.device_id === desktopDeviceId);
assert.equal(memberDesktopRecord?.desktopApps?.length, 1);

const desktopRevoke = await edge("owner/revoke", { deviceId: desktopDeviceId, roomId }, ownerToken);
expectStatus(desktopRevoke, 200, "desktop device revocation");
const desktopRevokedStatus = await edge("device/status", {}, desktopToken);
expectStatus(desktopRevokedStatus, 200, "revoked desktop credential status");
assert.equal(desktopRevokedStatus.body.status, "revoked");
const desktopAfterRevoke = await edge("room/devices", { roomId }, ownerToken);
expectStatus(desktopAfterRevoke, 200, "desktop app inventory after revocation");
const revokedDesktopRecord = desktopAfterRevoke.body.devices.find(item => item.device_id === desktopDeviceId);
assert.deepEqual(revokedDesktopRecord?.desktopApps, [], "revocation must delete desktop app inventory");
const desktopBlockedInventory = await edge("device/inventory", { apps: [] }, desktopToken);
expectStatus(desktopBlockedInventory, 401, "revoked desktop inventory denial");

console.log("Local Backroom Android pairing and account-authenticated desktop registration, authorization, token secrecy, member visibility and revocation passed:", roomId, deviceId, desktopDeviceId);
