#!/usr/bin/env node
/**
 * End-to-end interoperability test using the official MCP TypeScript client
 * against the disposable local Supabase Edge Function.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const endpoint = process.env.LOCAL_MCP_ENDPOINT;
const apiUrl = process.env.LOCAL_SUPABASE_URL;
const serviceKey = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;
assert.ok(endpoint && apiUrl && serviceKey, "local MCP endpoint and Supabase service key are required");

const adminHeaders = {
  apikey: serviceKey,
  Authorization: "Bearer " + serviceKey,
  "Content-Type": "application/json",
};
async function request(path, init = {}) {
  const response = await fetch(apiUrl + path, {
    ...init,
    headers: { ...adminHeaders, ...(init.headers || {}) },
  });
  const body = await response.json().catch(() => null);
  assert.ok(response.ok, path + " failed (" + response.status + "): " + JSON.stringify(body));
  return body;
}

async function expectInvalidCompositeCursor(client, arguments_, label) {
  let result;
  let protocolError;
  try {
    result = await client.callTool({ name: "wait_for_group_messages", arguments: arguments_ });
  } catch (error) {
    protocolError = error;
  }

  // The official MCP SDK raises ProtocolError for a JSON-RPC invalid-params
  // response instead of returning a ToolResult with isError=true. Accept that
  // protocol-level rejection, while retaining compatibility with clients that
  // expose the same rejection as an error tool result.
  if (protocolError) {
    assert.equal(protocolError.code, -32602, label + " must fail with JSON-RPC invalid params");
    assert.match(
      String(protocolError.message),
      /after_created_at and after_message_id must be supplied together for a composite cursor/i,
      label + " must explain why the incomplete cursor is invalid",
    );
    return;
  }

  assert.equal(result?.isError, true, label + " must be rejected rather than accepted");
  const detail = result?.structuredContent?.error ??
    (Array.isArray(result?.content) ? result.content.map(item => item?.text || "").join("\n") : "");
  assert.match(
    String(detail),
    /after_created_at and after_message_id must be supplied together for a composite cursor/i,
    label + " must explain why the incomplete cursor is invalid",
  );
}

const owner = await request("/auth/v1/admin/users", {
  method: "POST",
  body: JSON.stringify({
    email: "rub-minds-official-mcp-owner@example.test",
    password: "Local-CI-Official-MCP-Owner-923!x",
    email_confirm: true,
  }),
});
const rooms = await request("/rest/v1/rooms", {
  method: "POST",
  headers: { Prefer: "return=representation" },
  body: JSON.stringify({
    owner_id: owner.id,
    title: "Official MCP client interoperability",
    objective: "Two official SDK clients join and collaborate in isolated CI",
  }),
});
assert.equal(rooms.length, 1);
const room = rooms[0];
console.log("SAFE_MCP_E2E_STAGE: owner and disposable room ready");

const publicKey = process.env.LOCAL_SUPABASE_ANON_KEY;
assert.ok(publicKey, "local anon key is required for authenticated Backroom frame API tests");
const ownerPassword = "Local-CI-Official-MCP-Owner-923!x";
const ownerLoginResponse = await fetch(apiUrl + "/auth/v1/token?grant_type=password", {
  method: "POST", headers: { apikey: publicKey, "Content-Type": "application/json" },
  body: JSON.stringify({ email: "rub-minds-official-mcp-owner@example.test", password: ownerPassword }),
});
const ownerLogin = await ownerLoginResponse.json();
assert.equal(ownerLoginResponse.status, 200, "room owner sign-in failed");
assert.ok(ownerLogin.access_token);
const ownerHeaders = { apikey: publicKey, Authorization: "Bearer " + ownerLogin.access_token, "Content-Type": "application/json" };
async function ownerRequest(path, init = {}) {
  const response = await fetch(apiUrl + path, { ...init, headers: { ...ownerHeaders, ...(init.headers || {}) } });
  const payload = await response.json().catch(() => null);
  assert.ok(response.ok, "owner request failed " + path + " (" + response.status + "): " + JSON.stringify(payload));
  return payload;
}
async function backroomEdge(action, fields, accessToken = ownerLogin.access_token) {
  const response = await fetch(apiUrl + "/functions/v1/backroom-device", {
    method: "POST",
    headers: { apikey: publicKey, ...(accessToken ? { Authorization: "Bearer " + accessToken } : {}), "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...fields }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}
const nonMemberEmail = "rub-minds-official-mcp-outsider@example.test";
const nonMemberPassword = "Local-CI-Official-MCP-Outsider-923!x";
await request("/auth/v1/admin/users", { method: "POST", body: JSON.stringify({ email: nonMemberEmail, password: nonMemberPassword, email_confirm: true }) });
const nonMemberLoginResponse = await fetch(apiUrl + "/auth/v1/token?grant_type=password", {
  method: "POST", headers: { apikey: publicKey, "Content-Type": "application/json" },
  body: JSON.stringify({ email: nonMemberEmail, password: nonMemberPassword }),
});
const nonMemberLogin = await nonMemberLoginResponse.json();
assert.equal(nonMemberLoginResponse.status, 200, "outsider sign-in failed");
assert.ok(nonMemberLogin.access_token);
console.log("SAFE_MCP_E2E_STAGE: owner and outsider auth fixtures ready");
const inviteToken = "e".repeat(64);
const tokenHash = createHash("sha256").update(inviteToken, "utf8").digest("hex");
await request("/rest/v1/room_invites", {
  method: "POST",
  headers: { Prefer: "return=representation" },
  body: JSON.stringify({
    room_id: room.id,
    created_by: owner.id,
    token_hash: tokenHash,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    max_uses: 3,
    uses: 0,
    allow_ai: true,
    max_ai_uses: 2,
    ai_uses: 0,
  }),
});

// Each negative invitation uses the real database and official MCP client.
const rejectedInvites = [
  { label: "expired", token: "1".repeat(64), expires_at: new Date(Date.now() - 60_000).toISOString(), revoked_at: null, allow_ai: true, max_ai_uses: 2 },
  { label: "revoked", token: "2".repeat(64), expires_at: new Date(Date.now() + 3_600_000).toISOString(), revoked_at: new Date().toISOString(), allow_ai: true, max_ai_uses: 2 },
  { label: "human-only", token: "3".repeat(64), expires_at: new Date(Date.now() + 3_600_000).toISOString(), revoked_at: null, allow_ai: false, max_ai_uses: 0 },
];
for (const entry of rejectedInvites) {
  const rows = await request("/rest/v1/room_invites", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      room_id: room.id,
      created_by: owner.id,
      token_hash: createHash("sha256").update(entry.token, "utf8").digest("hex"),
      expires_at: entry.expires_at,
      revoked_at: entry.revoked_at,
      max_uses: 3,
      uses: 0,
      allow_ai: entry.allow_ai,
      max_ai_uses: entry.max_ai_uses,
      ai_uses: 0,
    }),
  });
  assert.equal(rows.length, 1, "could not seed " + entry.label + " invitation");
  entry.invite_id = rows[0].id;
}

const first = new Client(
  { name: "rub-minds-ci-ai-one", version: "1.0.0" },
  { versionNegotiation: { mode: "auto" } },
);
const second = new Client(
  { name: "rub-minds-ci-ai-two", version: "1.0.0" },
  { versionNegotiation: { mode: "auto" } },
);
const firstTransport = new StreamableHTTPClientTransport(new URL(endpoint));
const secondTransport = new StreamableHTTPClientTransport(new URL(endpoint));

try {
  await Promise.all([first.connect(firstTransport), second.connect(secondTransport)]);
  assert.equal(first.getProtocolEra(), "modern", "official client must negotiate the 2026 MCP protocol");
  assert.equal(second.getProtocolEra(), "modern", "second official client must negotiate the 2026 MCP protocol");
  console.log("SAFE_MCP_E2E_STAGE: two official SDK clients negotiated modern MCP");

  const catalog = await first.listTools();
  const names = catalog.tools.map(tool => tool.name);
  assert.ok(names.includes("join_group"), "official client did not discover join_group");
  assert.ok(names.includes("leave_group"), "official client did not discover leave_group");
  assert.ok(names.includes("bind_device_frame"), "official client did not discover bind_device_frame");
  assert.ok(names.includes("send_group_message"), "official client did not discover send_group_message");
  assert.ok(names.includes("read_group_messages"), "official client did not discover read_group_messages");
  assert.ok(names.includes("wait_for_group_messages"), "official client did not discover wait_for_group_messages");
  assert.ok(names.includes("forget_memory"), "official client did not discover forget_memory");
  assert.ok(names.includes("load_original_session_bridge_state"), "official client did not discover bridge-state load");
  assert.ok(names.includes("save_original_session_bridge_state"), "official client did not discover bridge-state save");
  console.log("SAFE_MCP_E2E_STAGE: MCP tool catalog discovery passed");

  for (const entry of rejectedInvites) {
    const rejected = await first.callTool({
      name: "join_group",
      arguments: {
        invite_token: entry.token,
        agent_label: "CI rejected " + entry.label,
        confirm_join: true,
        join_request_key: createHash("sha256").update("negative-" + entry.label).digest("hex"),
      },
    });
    assert.equal(rejected.isError, true, entry.label + " invitation unexpectedly authorized an AI join");
    const unchanged = await request("/rest/v1/room_invites?select=ai_uses&id=eq." + entry.invite_id);
    assert.equal(unchanged[0]?.ai_uses, 0, entry.label + " invitation consumed an AI slot");
  }
  // Invalid MCP tool arguments may be rejected as a protocol error before a
  // tool result exists. Both protocol rejection and isError are fail-closed.
  let consentRejected = false;
  try {
    const noConsent = await first.callTool({
      name: "join_group",
      arguments: {
        invite_token: inviteToken,
        agent_label: "CI no consent",
        confirm_join: false,
        join_request_key: "4".repeat(64),
      },
    });
    consentRejected = noConsent.isError === true || noConsent.structuredContent?.joined !== true;
  } catch (error) {
    consentRejected = error?.code === -32602 &&
      /explicit confirmation/i.test(String(error.message));
  }
  assert.equal(consentRejected, true, "join_group must reject missing explicit consent");
  const noConsentParticipants = await request(
    "/rest/v1/participants?select=id&room_id=eq." + room.id + "&display_name=eq.CI%20no%20consent",
  );
  assert.equal(noConsentParticipants.length, 0, "missing consent must not create a participant");
  console.log("SAFE_MCP_E2E_STAGE: negative invitation and consent rejection passed");

  const [joinOne, joinTwo] = await Promise.all([
    first.callTool({
      name: "join_group",
      arguments: {
        invite_token: inviteToken,
        agent_label: "Official SDK AI one",
        confirm_join: true,
        join_request_key: "a".repeat(64),
      },
    }),
    second.callTool({
      name: "join_group",
      arguments: {
        invite_token: inviteToken,
        agent_label: "Official SDK AI two",
        confirm_join: true,
        join_request_key: "b".repeat(64),
      },
    }),
  ]);
  assert.notEqual(joinOne.isError, true, "official SDK AI one could not join: " + JSON.stringify(joinOne));
  assert.notEqual(joinTwo.isError, true, "official SDK AI two could not join: " + JSON.stringify(joinTwo));
  const one = joinOne.structuredContent;
  const two = joinTwo.structuredContent;
  assert.equal(one?.joined, true);
  assert.equal(two?.joined, true);
  assert.equal(one?.room_id, room.id);
  assert.equal(two?.room_id, room.id);
  assert.ok(typeof one?.session_handle === "string" && /^[a-f0-9]{64}$/i.test(one.session_handle));
  assert.ok(typeof two?.session_handle === "string" && /^[a-f0-9]{64}$/i.test(two.session_handle));
  assert.notEqual(one.participant_id, two.participant_id, "independent clients must have distinct participants");
  assert.notEqual(one.session_handle, two.session_handle, "independent clients must have distinct session handles");
  console.log("SAFE_MCP_E2E_STAGE: two independent AI participants joined the same group");

  // Create a disposable desktop frame using the existing privileged registration RPC.
  // The challenge is scoped to one exact AI participant AND its MCP session digest.
  const frameDeviceId = randomUUID();
  const frameRuntimeId = randomUUID();
  const frameRuntimeTwoId = randomUUID();
  const frameAppId = randomUUID();
  const frameAppTwoId = randomUUID();
  const frameAppFingerprint = createHash("sha256").update("rub-minds-ci-frame-app-fingerprint").digest("hex");
  const frameAppFingerprintTwo = createHash("sha256").update("rub-minds-ci-frame-app-fingerprint-two").digest("hex");
  const frameSessionDigest = createHash("sha256").update(one.session_handle, "utf8").digest("hex");

  const registeredFrameDevice = await request("/rest/v1/rpc/register_backroom_desktop_device", {
    method: "POST",
    body: JSON.stringify({
      p_device_id: frameDeviceId,
      p_owner_id: owner.id,
      p_room_id: room.id,
      p_token_digest: createHash("sha256").update("rub-minds-ci-device-token").digest("hex"),
      p_device_public_key: createHash("sha256").update("rub-minds-ci-device-public-key").digest("hex"),
      p_device_label: "Disposable MCP frame computer",
      p_platform: "windows",
      p_os_version: "CI",
      p_app_version: "0.1.0",
    }),
  });
  assert.equal(registeredFrameDevice?.[0]?.device_id, frameDeviceId,
    "desktop registration must create the disposable device and room binding");

  await request("/rest/v1/backroom_desktop_apps", {
    method: "POST",
    body: JSON.stringify({
      device_id: frameDeviceId,
      app_id: frameAppId,
      app_label: "Disposable AI app",
      executable_sha256: frameAppFingerprint,
    }),
  });
  await request("/rest/v1/backroom_desktop_sessions", {
    method: "POST",
    body: JSON.stringify({
      session_id: frameRuntimeId,
      device_id: frameDeviceId,
      room_id: room.id,
      requested_by: owner.id,
      session_type: "screen",
      status: "active",
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      target_app_id: frameAppId,
      target_app_fingerprint: frameAppFingerprint,
    }),
  });
  const frameRequest = {
    deviceId: frameDeviceId, roomId: room.id, requestId: randomUUID(),
    issuedAt: Date.now(), runtimeSessionId: frameRuntimeId,
    participantId: one.participant_id, surface: "desktop_app",
  };
  const noAuthChallenge = await backroomEdge("device-frame/binding-challenge", frameRequest, null);
  assert.equal(noAuthChallenge.status, 401, "frame challenge requires authentication");
  const outsiderChallenge = await backroomEdge("device-frame/binding-challenge", frameRequest, nonMemberLogin.access_token);
  assert.equal(outsiderChallenge.status, 403, "non-member cannot issue a frame challenge");
  const candidates = await backroomEdge("device-frame/ai-candidates", { roomId: room.id });
  assert.equal(candidates.status, 200);
  assert.ok(candidates.body.candidates.some(row => row.participantId === one.participant_id));
  const ownerChallenge = await backroomEdge("device-frame/binding-challenge", frameRequest);
  assert.equal(ownerChallenge.status, 201, "owner challenge failed: " + JSON.stringify(ownerChallenge.body));
  assert.equal(ownerChallenge.body.participantId, one.participant_id);
  const frameChallengeIdFromOwner = ownerChallenge.body.challengeId;
  const frameNonceFromOwner = ownerChallenge.body.nonce;

  const wrongSessionFrameBind = await second.callTool({
    name: "bind_device_frame",
    arguments: {
      session_handle: two.session_handle,
      challenge_id: frameChallengeIdFromOwner,
      nonce: frameNonceFromOwner,
      confirm_bind: true,
    },
  });
  assert.equal(wrongSessionFrameBind.isError, true,
    "a different AI conversation must not redeem the selected AI session's frame challenge");

  const frameBind = await first.callTool({
    name: "bind_device_frame",
    arguments: {
      session_handle: one.session_handle,
      challenge_id: frameChallengeIdFromOwner,
      nonce: frameNonceFromOwner,
      confirm_bind: true,
    },
  });
  assert.notEqual(frameBind.isError, true,
    "the selected joined AI session could not bind to its desktop frame: " + JSON.stringify(frameBind));
  assert.equal(frameBind.structuredContent?.bound, true);
  assert.equal(frameBind.structuredContent?.participant_id, one.participant_id);
  assert.equal(frameBind.structuredContent?.surface, "desktop_app");
  assert.equal(frameBind.structuredContent?.capabilities?.group_collaboration, true);
  assert.equal(frameBind.structuredContent?.capabilities?.app_control, false);
  assert.equal(frameBind.structuredContent?.capabilities?.native_send, false);
  assert.equal(frameBind.structuredContent?.capabilities?.automatic_wake, false);

  const frameBindRetry = await first.callTool({
    name: "bind_device_frame",
    arguments: {
      session_handle: one.session_handle,
      challenge_id: frameChallengeIdFromOwner,
      nonce: frameNonceFromOwner,
      confirm_bind: true,
    },
  });
  assert.notEqual(frameBindRetry.isError, true, "same-session frame-binding retry must be idempotent");
  assert.equal(frameBindRetry.structuredContent?.binding_id, frameBind.structuredContent.binding_id);
  assert.equal(frameBindRetry.structuredContent?.replayed, true);
  const persistedFrameBinding = await request(
    "/rest/v1/backroom_device_frame_bindings?select=id,participant_id,session_digest,revoked_at&challenge_id=eq." + frameChallengeIdFromOwner,
  );
  assert.equal(persistedFrameBinding.length, 1);
  assert.equal(persistedFrameBinding[0].participant_id, one.participant_id);
  assert.equal(persistedFrameBinding[0].session_digest, frameSessionDigest);
  assert.equal(persistedFrameBinding[0].revoked_at, null);
  console.log("SAFE_MCP_E2E_STAGE: desktop frame exact-session bind, wrong-session denial and retry passed");

  // A second runtime tests owner status/revoke routes while AI one's link remains
  // active until Leave below, preserving the independent lifecycle assertion.
  await request("/rest/v1/backroom_desktop_apps", { method: "POST", body: JSON.stringify({
    device_id: frameDeviceId, app_id: frameAppTwoId, app_label: "Disposable AI app two",
    executable_sha256: frameAppFingerprintTwo,
  }) });
  console.log("SAFE_MCP_E2E_STAGE: second desktop app registered");
  await request("/rest/v1/backroom_desktop_sessions", { method: "POST", body: JSON.stringify({
    session_id: frameRuntimeTwoId, device_id: frameDeviceId, room_id: room.id, requested_by: owner.id,
    session_type: "screen", status: "active", expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    target_app_id: frameAppTwoId, target_app_fingerprint: frameAppFingerprintTwo,
  }) });
  console.log("SAFE_MCP_E2E_STAGE: second desktop runtime registered");
  const secondFrameRequest = {
    deviceId: frameDeviceId, roomId: room.id, requestId: randomUUID(),
    issuedAt: Date.now(), runtimeSessionId: frameRuntimeTwoId,
    participantId: two.participant_id, surface: "desktop_app",
  };
  const secondOwnerChallenge = await backroomEdge("device-frame/binding-challenge", secondFrameRequest);
  assert.equal(secondOwnerChallenge.status, 201, "owner could not issue second AI frame challenge");
  console.log("SAFE_MCP_E2E_STAGE: second AI frame challenge issued");
  const secondFrameBind = await second.callTool({ name: "bind_device_frame", arguments: {
    session_handle: two.session_handle, challenge_id: secondOwnerChallenge.body.challengeId,
    nonce: secondOwnerChallenge.body.nonce, confirm_bind: true,
  } });
  assert.notEqual(secondFrameBind.isError, true, "second selected AI could not bind");
  assert.equal(secondFrameBind.structuredContent?.participant_id, two.participant_id);
  console.log("SAFE_MCP_E2E_STAGE: second AI frame binding succeeded");
  const statusRequest = { deviceId: frameDeviceId, roomId: room.id, runtimeSessionId: frameRuntimeTwoId };
  const outsiderStatus = await backroomEdge("device-frame/binding-status", statusRequest, nonMemberLogin.access_token);
  assert.equal(outsiderStatus.status, 403, "non-member cannot read frame status");
  const ownerStatus = await backroomEdge("device-frame/binding-status", statusRequest);
  assert.equal(ownerStatus.status, 200);
  assert.equal(ownerStatus.body.binding?.participant_id, two.participant_id);
  console.log("SAFE_MCP_E2E_STAGE: owner read second binding status; outsider status denied");
  const outsiderRevoke = await backroomEdge("device-frame/binding-revoke", {
    ...statusRequest, bindingId: ownerStatus.body.binding.id,
  }, nonMemberLogin.access_token);
  assert.equal(outsiderRevoke.status, 403, "non-member cannot revoke frame binding");
  console.log("SAFE_MCP_E2E_STAGE: outsider binding revoke denied");
  const ownerRevoke = await backroomEdge("device-frame/binding-revoke", {
    ...statusRequest, bindingId: ownerStatus.body.binding.id,
  });
  assert.equal(ownerRevoke.status, 200);
  assert.equal(ownerRevoke.body.revoked, true);
  console.log("SAFE_MCP_E2E_STAGE: owner binding revoke succeeded");
  const postRevokeStatus = await backroomEdge("device-frame/binding-status", statusRequest);
  assert.equal(postRevokeStatus.status, 200);
  assert.equal(postRevokeStatus.body.binding, null);
  console.log("SAFE_MCP_E2E_STAGE: revoked binding no longer appears in status");
  console.log("SAFE_MCP_E2E_STAGE: frame challenge, status and revoke owner boundaries passed");



  // Create a real baseline message and use its exact ID + timestamp as the
  // cursor. This proves the wait returns subsequent activity without replaying
  // the cursor message; a timestamp-only test would not cover the new ID path.
  const cursorBody = "Realtime cursor baseline from official SDK AI two";
  const cursorSend = await second.callTool({
    name: "send_group_message",
    arguments: {
      session_handle: two.session_handle,
      body: cursorBody,
      source_message_id: "official-sdk-realtime-cursor-baseline",
    },
  });
  assert.notEqual(cursorSend.isError, true, "second AI could not send the cursor baseline message");
  const baselineRead = await first.callTool({
    name: "read_group_messages",
    arguments: { session_handle: one.session_handle },
  });
  assert.notEqual(baselineRead.isError, true, "first AI could not read the cursor baseline message");
  const cursorMessage = baselineRead.structuredContent?.messages?.find(message => message.body === cursorBody);
  assert.ok(cursorMessage?.id, "baseline message did not expose its persisted message ID");
  assert.ok(cursorMessage?.created_at, "baseline message did not expose its creation timestamp");

  await expectInvalidCompositeCursor(first, {
    session_handle: one.session_handle,
    after_created_at: cursorMessage.created_at,
    timeout_ms: 1000,
  }, "timestamp-only cursor");
  await expectInvalidCompositeCursor(first, {
    session_handle: one.session_handle,
    after_message_id: cursorMessage.id,
    timeout_ms: 1000,
  }, "ID-only cursor");

  // Prove the MCP tool can wait on a real Supabase Realtime Postgres Changes
  // subscription. Delay the second client's send so the first subscription is
  // established; a timeout or unavailable subscription must fail this test.
  const waitingForRealtime = first.callTool({
    name: "wait_for_group_messages",
    arguments: {
      session_handle: one.session_handle,
      after_message_id: cursorMessage.id,
      after_created_at: cursorMessage.created_at,
      timeout_ms: 8000,
    },
  });
  await new Promise(resolve => setTimeout(resolve, 3500));
  const realtimeBody = "Realtime wake-up from official SDK AI two";
  const realtimeSend = await second.callTool({
    name: "send_group_message",
    arguments: {
      session_handle: two.session_handle,
      body: realtimeBody,
      source_message_id: "official-sdk-realtime-wake",
    },
  });
  assert.notEqual(realtimeSend.isError, true, "second AI could not send the Realtime wake-up message");
  const realtimeRead = await waitingForRealtime;
  assert.notEqual(realtimeRead.isError, true, "Realtime wait tool failed: " + JSON.stringify(realtimeRead));
  assert.equal(realtimeRead.structuredContent?.timed_out, false, "Realtime wait timed out instead of waking on a new message: " + JSON.stringify(realtimeRead.structuredContent));
  assert.equal(realtimeRead.structuredContent?.delivery, "realtime", "message was not delivered through the Realtime subscription");
  assert.ok(
    realtimeRead.structuredContent?.messages?.some(message => message.body === realtimeBody),
    "waiting AI did not retrieve the message that woke its Realtime subscription",
  );
  assert.ok(
    !realtimeRead.structuredContent?.messages?.some(message => message.id === cursorMessage.id || message.body === cursorBody),
    "Realtime wait replayed the exact cursor message",
  );
  console.log("SAFE_MCP_E2E_STAGE: Supabase Realtime wait woke on the new message without cursor replay");

  // Exercise real PostgreSQL composite pagination when two messages share
  // the exact same microsecond timestamp. A timestamp-only cursor would skip
  // or replay one of these rows, so page 1 and page 2 must use the stable ID tie-breaker.
  const tieTimestamp = new Date(Date.now() + 60_000).toISOString().replace(/\.\d{3}Z$/, ".123456Z");
  const lowerTieCursorId = "e0000000-0000-4000-8000-000000000001";
  const tieMessageOneId = "f1000000-0000-4000-8000-000000000001";
  const tieMessageTwoId = "f2000000-0000-4000-8000-000000000001";
  await request("/rest/v1/messages", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify([
      {
        id: tieMessageOneId,
        room_id: room.id,
        sender_id: two.participant_id,
        body: "Composite cursor same-time page one",
        created_at: tieTimestamp,
      },
      {
        id: tieMessageTwoId,
        room_id: room.id,
        sender_id: two.participant_id,
        body: "Composite cursor same-time page two",
        created_at: tieTimestamp,
      },
    ]),
  });
  const firstTiePage = await first.callTool({
    name: "read_group_messages",
    arguments: {
      session_handle: one.session_handle,
      after_created_at: tieTimestamp,
      after_message_id: lowerTieCursorId,
      limit: 1,
    },
  });
  assert.notEqual(firstTiePage.isError, true,
    "official MCP client could not read first composite cursor page: " + JSON.stringify(firstTiePage));
  assert.deepEqual(firstTiePage.structuredContent?.messages?.map(message => message.id), [tieMessageOneId]);
  assert.equal(firstTiePage.structuredContent?.has_more, true);
  assert.equal(firstTiePage.structuredContent?.next_cursor?.after_message_id, tieMessageOneId);

  const secondTiePage = await first.callTool({
    name: "read_group_messages",
    arguments: {
      session_handle: one.session_handle,
      after_created_at: firstTiePage.structuredContent.next_cursor.after_created_at,
      after_message_id: firstTiePage.structuredContent.next_cursor.after_message_id,
      limit: 1,
    },
  });
  assert.notEqual(secondTiePage.isError, true,
    "official MCP client could not read the next composite cursor page: " + JSON.stringify(secondTiePage));
  assert.deepEqual(secondTiePage.structuredContent?.messages?.map(message => message.id), [tieMessageTwoId]);
  assert.equal(secondTiePage.structuredContent?.has_more, false);
  assert.equal(secondTiePage.structuredContent?.next_cursor?.after_message_id, tieMessageTwoId);
  console.log("SAFE_MCP_E2E_STAGE: same-timestamp composite pagination passed");


  // Two successful AI joins exhaust this invitation's AI quota. A third
  // independent request must not create a participant or a scoped credential.
  const exhausted = await first.callTool({
    name: "join_group",
    arguments: {
      invite_token: inviteToken,
      agent_label: "CI quota exceeded",
      confirm_join: true,
      join_request_key: "5".repeat(64),
    },
  });
  assert.equal(exhausted.isError, true, "exhausted AI invitation unexpectedly authorized a third AI");
  const inviteAfterQuota = await request(
    "/rest/v1/room_invites?select=ai_uses,max_ai_uses&token_hash=eq." + tokenHash,
  );
  assert.equal(inviteAfterQuota[0]?.ai_uses, 2, "two successful AI joins should consume exactly two slots");
  assert.equal(inviteAfterQuota[0]?.max_ai_uses, 2, "test invitation should cap AI participation at two");
  const quotaParticipants = await request(
    "/rest/v1/participants?select=id&room_id=eq." + room.id + "&display_name=eq.CI%20quota%20exceeded",
  );
  assert.equal(quotaParticipants.length, 0, "quota rejection must not create a participant");
  console.log("SAFE_MCP_E2E_STAGE: AI invitation quota enforcement passed");

  // Import the original conversation context privately to AI one. AI two must
  // not receive the raw import or participant-private memory.
  const imported = await first.callTool({
    name: "import_session_memory",
    arguments: {
      session_handle: one.session_handle,
      document: {
        schema: "rub-minds.session-memory",
        version: 1,
        summary: "Private source context: prefers concise research and is investigating quantum batteries.",
        current_goal: "Investigate quantum batteries.",
        source: { platform: "ChatGPT", session_label: "AI one source conversation" },
        sharing: { raw_history_visibility: "private" },
      },
    },
  });
  assert.notEqual(imported.isError, true, "official SDK client could not import private session context: " + JSON.stringify(imported));
  assert.equal(imported.structuredContent?.imported, true);
  assert.equal(imported.structuredContent?.visibility, "private");

  const privateEntry = await first.callTool({
    name: "remember_memory",
    arguments: {
      session_handle: one.session_handle,
      entry_type: "insight",
      content: "PRIVATE ONLY: preserve the original user's unpublished research constraint.",
      visibility: "private",
      idempotency_key: "sdk-private-memory-one",
    },
  });
  assert.notEqual(privateEntry.isError, true, "private memory write failed: " + JSON.stringify(privateEntry));

  const recoveryPrefix = "Original AI conversation recovery URL (private; do not post to group messages): ";
  const recoveryEntry = await first.callTool({
    name: "remember_memory",
    arguments: {
      session_handle: one.session_handle,
      entry_type: "insight",
      content: recoveryPrefix + "https://chatgpt.com/c/ci-recovery-thread. This is only a locator, not an authentication credential.",
      visibility: "private",
      idempotency_key: "browser-resume-sdk-recovery-link-one",
    },
  });
  assert.notEqual(recoveryEntry.isError, true, "private browser recovery locator write failed: " + JSON.stringify(recoveryEntry));

  let reservedKeyMisuseRejected = false;
  try {
    await first.callTool({
      name: "remember_memory",
      arguments: {
        session_handle: one.session_handle,
        entry_type: "insight",
        content: "An ordinary private note must not be deletable through the recovery tool.",
        visibility: "private",
        idempotency_key: "browser-resume-sdk-private-memory-bad-note",
      },
    });
  } catch (error) {
    // The official MCP SDK surfaces JSON-RPC invalid-argument responses as
    // ProtocolError exceptions rather than a ToolResult with isError=true.
    reservedKeyMisuseRejected = String(error?.message || error).includes(
      "browser-resume idempotency keys are reserved for private browser-recovery locator entries.",
    );
  }
  assert.equal(reservedKeyMisuseRejected, true, "reserved recovery key must reject a non-locator note");

  // Seed a legacy/private non-locator row with a browser-resume key directly
  // into the disposable CI database to prove deletion has server-side defense
  // in depth for rows created before the namespace validation existed.
  const legacyRows = await request("/rest/v1/room_memory_entries", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      room_id: room.id,
      created_by_participant_id: one.participant_id,
      owner_id: owner.id,
      entry_type: "insight",
      visibility: "private",
      content: "Legacy private note that is not a browser recovery locator.",
      source_message_ids: [],
      idempotency_key: "browser-resume-sdk-legacy-note",
    }),
  });
  assert.equal(legacyRows.length, 1, "could not seed legacy private note for deletion regression test");

  const groupEntry = await first.callTool({
    name: "remember_memory",
    arguments: {
      session_handle: one.session_handle,
      entry_type: "decision",
      content: "SHARED DECISION: compare quantum battery papers by reproducibility.",
      visibility: "group",
      idempotency_key: "sdk-group-memory-one",
    },
  });
  assert.notEqual(groupEntry.isError, true, "group memory write failed: " + JSON.stringify(groupEntry));

  const [memoryOne, memoryTwo] = await Promise.all([
    first.callTool({
      name: "read_session_memory",
      arguments: { session_handle: one.session_handle },
    }),
    second.callTool({
      name: "read_session_memory",
      arguments: { session_handle: two.session_handle },
    }),
  ]);
  assert.notEqual(memoryOne.isError, true, "AI one could not read its own memory");
  assert.notEqual(memoryTwo.isError, true, "AI two could not read its memory");
  assert.ok(
    memoryOne.structuredContent?.imports?.some(entry => entry.context_summary?.includes("Private source context")),
    "AI one could not read its imported source summary",
  );
  assert.ok(
    memoryTwo.structuredContent?.imports?.length === 0,
    "AI two must not see AI one's imported source context",
  );
  assert.ok(
    memoryOne.structuredContent?.group_memory?.some(entry => entry.visibility === "private" && entry.content.includes("PRIVATE ONLY")),
    "AI one must retain access to its own ordinary private memory",
  );
  assert.ok(
    memoryOne.structuredContent?.group_memory?.some(entry => entry.visibility === "private" && entry.content.startsWith(recoveryPrefix)),
    "AI one must retain access to its own private recovery locator",
  );
  assert.ok(
    memoryOne.structuredContent?.group_memory?.some(entry => entry.visibility === "private" && entry.content.includes("Legacy private note")),
    "legacy private note should be present before deletion attempts",
  );
  assert.ok(
    !memoryTwo.structuredContent?.group_memory?.some(entry => entry.content.includes("PRIVATE ONLY") || entry.content.startsWith(recoveryPrefix) || entry.content.includes("Legacy private note")),
    "AI two must not see AI one's participant-private memory",
  );
  assert.ok(
    memoryTwo.structuredContent?.group_memory?.some(entry => entry.visibility === "group" && entry.content.includes("SHARED DECISION")),
    "AI two must see explicitly group-shared memory",
  );

  // Another participant cannot delete the private locator even with its key.
  const crossParticipantForget = await second.callTool({
    name: "forget_memory",
    arguments: {
      session_handle: two.session_handle,
      idempotency_key: "browser-resume-sdk-recovery-link-one",
      confirm_forget: true,
    },
  });
  assert.notEqual(crossParticipantForget.isError, true, "private-memory scoped no-op should be a valid tool result");
  assert.equal(crossParticipantForget.structuredContent?.forgotten, false);
  assert.equal(crossParticipantForget.structuredContent?.not_found, true);

  // Even the owner cannot delete an ordinary legacy private note just because
  // its old idempotency key happens to use the browser-resume namespace.
  const legacyForget = await first.callTool({
    name: "forget_memory",
    arguments: {
      session_handle: one.session_handle,
      idempotency_key: "browser-resume-sdk-legacy-note",
      confirm_forget: true,
    },
  });
  assert.notEqual(legacyForget.isError, true, "legacy private-note delete should be a safe no-op");
  assert.equal(legacyForget.structuredContent?.forgotten, false);
  assert.equal(legacyForget.structuredContent?.not_found, true);
  const stillPrivateForOwner = await first.callTool({
    name: "read_session_memory",
    arguments: { session_handle: one.session_handle },
  });
  assert.ok(stillPrivateForOwner.structuredContent?.group_memory?.some(entry =>
    entry.visibility === "private" && entry.content.includes("PRIVATE ONLY")),
    "an attempted recovery delete must not remove an ordinary private memory");
  assert.ok(stillPrivateForOwner.structuredContent?.group_memory?.some(entry =>
    entry.visibility === "private" && entry.content.includes("Legacy private note")),
    "recovery deletion must not remove legacy non-locator private rows");
  assert.ok(stillPrivateForOwner.structuredContent?.group_memory?.some(entry =>
    entry.visibility === "private" && entry.content.startsWith(recoveryPrefix)),
    "cross-participant deletion must not remove AI one's private recovery locator");

  const ownerForget = await first.callTool({
    name: "forget_memory",
    arguments: {
      session_handle: one.session_handle,
      idempotency_key: "browser-resume-sdk-recovery-link-one",
      confirm_forget: true,
    },
  });
  assert.notEqual(ownerForget.isError, true, "owner could not delete own private recovery locator");
  assert.equal(ownerForget.structuredContent?.forgotten, true);
  assert.equal(ownerForget.structuredContent?.visibility, "private");
  const afterForgetOne = await first.callTool({
    name: "read_session_memory",
    arguments: { session_handle: one.session_handle },
  });
  const afterForgetTwo = await second.callTool({
    name: "read_session_memory",
    arguments: { session_handle: two.session_handle },
  });
  assert.ok(afterForgetOne.structuredContent?.group_memory?.some(entry => entry.content.includes("PRIVATE ONLY")),
    "deleting the recovery locator must preserve ordinary private memory");
  assert.ok(afterForgetOne.structuredContent?.group_memory?.some(entry => entry.content.includes("Legacy private note")),
    "deleting the recovery locator must preserve legacy private notes");
  assert.ok(!afterForgetOne.structuredContent?.group_memory?.some(entry => entry.content.startsWith(recoveryPrefix)),
    "the deleted recovery locator remains visible to its owner");
  assert.ok(!afterForgetTwo.structuredContent?.group_memory?.some(entry => entry.content.startsWith(recoveryPrefix)),
    "the deleted recovery locator remains visible to another participant");
  assert.ok(afterForgetOne.structuredContent?.group_memory?.some(entry => entry.visibility === "group" && entry.content.includes("SHARED DECISION")),
    "deleting private recovery memory must preserve group memory for owner");
  assert.ok(afterForgetTwo.structuredContent?.group_memory?.some(entry => entry.visibility === "group" && entry.content.includes("SHARED DECISION")),
    "deleting private recovery memory must preserve group memory for other participants");
  const repeatedForget = await first.callTool({
    name: "forget_memory",
    arguments: {
      session_handle: one.session_handle,
      idempotency_key: "browser-resume-sdk-recovery-link-one",
      confirm_forget: true,
    },
  });
  assert.equal(repeatedForget.structuredContent?.forgotten, false, "repeated deletion must be a harmless idempotent no-op");
  assert.equal(repeatedForget.structuredContent?.not_found, true);
  console.log("Official MCP SDK verified recovery-only deletion: participant-scoped, preserves ordinary private notes and group memory, and safe to retry.");
  console.log("SAFE_MCP_E2E_STAGE: private session context and explicit group-memory isolation passed");

  const sent = await first.callTool({
    name: "send_group_message",
    arguments: {
      session_handle: one.session_handle,
      body: "Official MCP SDK AI one says hello to AI two",
      source_message_id: "official-sdk-e2e-message-one",
    },
  });
  assert.notEqual(sent.isError, true, "official SDK client could not send a group message: " + JSON.stringify(sent));
  // Retrying a message with the same source ID must not duplicate delivery.
  // This protects group timelines when an AI host retries after a timeout.
  const repeatedSend = await first.callTool({
    name: "send_group_message",
    arguments: {
      session_handle: one.session_handle,
      body: "Official MCP SDK AI one says hello to AI two",
      source_message_id: "official-sdk-e2e-message-one",
    },
  });
  assert.notEqual(repeatedSend.isError, true,
    "idempotent message retry must succeed: " + JSON.stringify(repeatedSend));
  const matchingMessages = await request(
    "/rest/v1/messages?select=id,source_message_id&source_message_id=eq.official-sdk-e2e-message-one",
  );
  assert.equal(matchingMessages.length, 1,
    "repeated AI delivery must persist exactly one group message");
  console.log("SAFE_MCP_E2E_STAGE: message retry idempotency passed");

  const read = await second.callTool({
    name: "read_group_messages",
    arguments: { session_handle: two.session_handle },
  });
  assert.notEqual(read.isError, true, "official SDK client could not read group messages: " + JSON.stringify(read));
  assert.ok(
    read.structuredContent?.messages?.some(message => message.body === "Official MCP SDK AI one says hello to AI two"),
    "second official client did not receive the first client's group message",
  );

  // Exercise the real human-to-AI bridge with a signed-in human using the
  // public anon key and RLS, never the service-role key for the message path.
  const humanEmail = "rub-minds-mcp-human-bridge@example.test";
  const humanPassword = "Local-CI-Human-Bridge-Password-923!x";
  const humanUser = await request("/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({
      email: humanEmail,
      password: humanPassword,
      email_confirm: true,
    }),
  });
  assert.ok(publicKey, "local anon key is required for human RLS checks");
  const humanLoginResponse = await fetch(apiUrl + "/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: { apikey: publicKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email: humanEmail, password: humanPassword }),
  });
  const humanLogin = await humanLoginResponse.json();
  assert.equal(humanLoginResponse.status, 200, "human password sign-in failed: " + JSON.stringify(humanLogin));
  assert.ok(humanLogin.access_token, "human session has no access token");
  const humanHeaders = {
    apikey: publicKey,
    Authorization: "Bearer " + humanLogin.access_token,
    "Content-Type": "application/json",
  };
  async function humanRequest(path, init = {}) {
    const response = await fetch(apiUrl + path, {
      ...init,
      headers: { ...humanHeaders, ...(init.headers || {}) },
    });
    const payload = await response.json().catch(() => null);
    assert.ok(response.ok, "human RLS request failed " + path + " (" + response.status + "): " + JSON.stringify(payload));
    return payload;
  }
  const humanRoomId = await humanRequest("/rest/v1/rpc/redeem_room_invite", {
    method: "POST",
    body: JSON.stringify({ invite_token: inviteToken }),
  });
  assert.equal(humanRoomId, room.id, "signed-in human could not redeem the same invitation as the AIs");
  const humanParticipants = await humanRequest(
    "/rest/v1/participants?select=id,kind,user_id&room_id=eq." + room.id + "&user_id=eq." + humanUser.id,
  );
  assert.equal(humanParticipants.length, 1, "human invite must create exactly one human participant");
  assert.equal(humanParticipants[0].kind, "human");
  const humanMessage = "Human participant asks both AI collaborators for a project update";
  const humanPosted = await humanRequest("/rest/v1/messages", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      room_id: room.id,
      sender_id: humanParticipants[0].id,
      body: humanMessage,
    }),
  });
  assert.equal(humanPosted.length, 1, "human message must be persisted through authenticated RLS");
  const aiReadsHuman = await second.callTool({
    name: "read_group_messages",
    arguments: { session_handle: two.session_handle },
  });
  assert.notEqual(aiReadsHuman.isError, true, "AI could not read a human-authored group message");
  assert.ok(
    aiReadsHuman.structuredContent?.messages?.some(message => message.body === humanMessage),
    "AI two did not receive the human's authenticated group message",
  );
  const aiReplyText = "AI two replies to the human participant via the shared room";
  const aiRepliesHuman = await second.callTool({
    name: "send_group_message",
    arguments: { session_handle: two.session_handle, body: aiReplyText },
  });
  assert.notEqual(aiRepliesHuman.isError, true, "AI could not send a response to the human");
  const humanReadsAi = await humanRequest(
    "/rest/v1/messages?select=body,sender_id&room_id=eq." + room.id + "&order=created_at.asc",
  );
  assert.ok(humanReadsAi.some(message => message.body === aiReplyText),
    "signed-in human did not receive the AI response through RLS");

  // A different authenticated user who has not redeemed an invite must not
  // read the room or its messages, even if the UUID is known.
  const outsiderEmail = "rub-minds-mcp-outsider@example.test";
  await request("/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({
      email: outsiderEmail,
      password: humanPassword,
      email_confirm: true,
    }),
  });
  const outsiderLoginResponse = await fetch(apiUrl + "/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: { apikey: publicKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email: outsiderEmail, password: humanPassword }),
  });
  const outsiderLogin = await outsiderLoginResponse.json();
  assert.equal(outsiderLoginResponse.status, 200, "outsider fixture could not authenticate");
  const outsiderHeaders = { apikey: publicKey, Authorization: "Bearer " + outsiderLogin.access_token };
  for (const path of [
    "/rest/v1/rooms?select=id&id=eq." + room.id,
    "/rest/v1/messages?select=id,body&room_id=eq." + room.id,
    "/rest/v1/participants?select=id&room_id=eq." + room.id,
  ]) {
    const outsiderResponse = await fetch(apiUrl + path, { headers: outsiderHeaders });
    const outsiderRows = await outsiderResponse.json();
    assert.equal(outsiderResponse.status, 200, "outsider RLS query failed unexpectedly: " + path);
    assert.deepEqual(outsiderRows, [], "non-member must not see private group data: " + path);
  }
  // Anonymous visitors must not bypass the room's RLS simply by knowing
  // its UUID. These checks use the public anon key without a user JWT.
  const anonymousHeaders = { apikey: publicKey, Authorization: "Bearer " + publicKey };
  for (const path of [
    "/rest/v1/rooms?select=id&id=eq." + room.id,
    "/rest/v1/messages?select=id,body&room_id=eq." + room.id,
    "/rest/v1/participants?select=id&room_id=eq." + room.id,
  ]) {
    const response = await fetch(apiUrl + path, { headers: anonymousHeaders });
    const rows = await response.json();
    assert.ok(response.status === 200 || response.status === 401 || response.status === 403,
      "unexpected anonymous access result for " + path + ": " + response.status);
    if (response.status === 200) {
      assert.deepEqual(rows, [], "anonymous visitors must not see private room data: " + path);
    }
  }
  const anonymousPost = await fetch(apiUrl + "/rest/v1/messages", {
    method: "POST",
    headers: { ...anonymousHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      room_id: room.id,
      sender_id: humanParticipants[0].id,
      body: "CI anonymous write must be rejected",
    }),
  });
  assert.ok(anonymousPost.status >= 400, "anonymous visitor must not post as a room member");
  console.log("Anonymous read and write access denied by group RLS.");

  // A nonmember cannot submit a message under a member's participant ID.
  const unauthorizedPost = await fetch(apiUrl + "/rest/v1/messages", {
    method: "POST",
    headers: { ...outsiderHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({
      room_id: room.id,
      sender_id: humanParticipants[0].id,
      body: "CI nonmember write must be rejected",
    }),
  });
  assert.ok(unauthorizedPost.status >= 400, "nonmember message write must be denied");
  // Membership permits posting only as the caller's own human identity.
  const impersonatedPost = await fetch(apiUrl + "/rest/v1/messages", {
    method: "POST",
    headers: { ...humanHeaders, Prefer: "return=representation" },
    body: JSON.stringify({
      room_id: room.id,
      sender_id: one.participant_id,
      body: "CI human impersonation must be rejected",
    }),
  });
  assert.ok(impersonatedPost.status >= 400, "human must not post as an AI participant");
  const forbiddenRows = await request(
    "/rest/v1/messages?select=id&body=eq.CI%20human%20impersonation%20must%20be%20rejected",
  );
  assert.deepEqual(forbiddenRows, [], "rejected sender impersonation must not persist");
  console.log("SAFE_MCP_E2E_STAGE: human/AI two-way messaging and outsider RLS checks passed");

  // Exercise private, revision-checked original-session bridge state through
  // the real hosted MCP handler. Each MCP session receives a distinct row.
  const firstBridgeState = await first.callTool({
    name: "load_original_session_bridge_state",
    arguments: { session_handle: one.session_handle },
  });
  assert.notEqual(firstBridgeState.isError, true,
    "official MCP client could not initialize bridge state: " + JSON.stringify(firstBridgeState));
  assert.equal(firstBridgeState.structuredContent?.revision, 0);
  assert.equal(firstBridgeState.structuredContent?.cursor, null);
  const secondBridgeState = await second.callTool({
    name: "load_original_session_bridge_state",
    arguments: { session_handle: two.session_handle },
  });
  assert.notEqual(secondBridgeState.isError, true,
    "second MCP client could not initialize its separate bridge state");
  assert.equal(secondBridgeState.structuredContent?.revision, 0);
  assert.equal(secondBridgeState.structuredContent?.pending_response, null);

  const stateMessages = await request(
    "/rest/v1/messages?select=id,created_at&room_id=eq." + room.id + "&order=created_at.desc&limit=1",
  );
  assert.equal(stateMessages.length, 1, "a persisted group message is required for a realistic bridge cursor");
  const stateMessage = stateMessages[0];
  const bridgeSave = await first.callTool({
    name: "save_original_session_bridge_state",
    arguments: {
      session_handle: one.session_handle,
      expected_revision: firstBridgeState.structuredContent.revision,
      cursor_created_at: stateMessage.created_at,
      cursor_message_id: stateMessage.id,
      pending_message_id: stateMessage.id,
      pending_message_created_at: stateMessage.created_at,
      pending_response: "A completed original-session reply awaiting group delivery.",
      blocked_message_id: null,
      blocked_reason: null,
    },
  });
  assert.notEqual(bridgeSave.isError, true, "bridge state save failed: " + JSON.stringify(bridgeSave));
  assert.equal(bridgeSave.structuredContent?.saved, true);
  assert.equal(bridgeSave.structuredContent?.revision, 1);

  const staleSave = await first.callTool({
    name: "save_original_session_bridge_state",
    arguments: {
      session_handle: one.session_handle,
      expected_revision: 0,
      cursor_created_at: null,
      cursor_message_id: null,
      pending_message_id: null,
      pending_message_created_at: null,
      pending_response: null,
      blocked_message_id: null,
      blocked_reason: null,
    },
  });
  assert.notEqual(staleSave.isError, true, "a stale CAS write should return an explicit conflict, not an RPC error");
  assert.equal(staleSave.structuredContent?.saved, false);
  assert.equal(staleSave.structuredContent?.conflict, true);
  assert.equal(staleSave.structuredContent?.revision, 1);

  const isolatedState = await second.callTool({
    name: "load_original_session_bridge_state",
    arguments: { session_handle: two.session_handle },
  });
  assert.notEqual(isolatedState.isError, true);
  assert.equal(isolatedState.structuredContent?.revision, 0);
  assert.equal(isolatedState.structuredContent?.cursor, null,
    "one AI session must not read the other session's message cursor");
  assert.equal(isolatedState.structuredContent?.pending_response, null,
    "one AI session must not read the other session's private pending reply");

  const firstSessionDigestForState = createHash("sha256").update(one.session_handle, "utf8").digest("hex");
  const secondSessionDigestForState = createHash("sha256").update(two.session_handle, "utf8").digest("hex");
  const persistedState = await request(
    "/rest/v1/rub_minds_mcp_bridge_state?select=session_digest,cursor_message_id,pending_response,revision&session_digest=eq." + firstSessionDigestForState,
  );
  const isolatedPersistedState = await request(
    "/rest/v1/rub_minds_mcp_bridge_state?select=session_digest,cursor_message_id,pending_response,revision&session_digest=eq." + secondSessionDigestForState,
  );
  assert.equal(persistedState.length, 1);
  assert.equal(persistedState[0].cursor_message_id, stateMessage.id);
  assert.equal(persistedState[0].pending_response, "A completed original-session reply awaiting group delivery.");
  assert.equal(persistedState[0].revision, 1);
  assert.equal(isolatedPersistedState.length, 1);
  assert.equal(isolatedPersistedState[0].pending_response, null);

  // Exercise the complete group-task lifecycle through the hosted MCP tools
  // and human RPCs. Proposals remain unassigned until a signed-in human assigns them.
  // Reuse the owner-authenticated helper created before the MCP clients.

  // A room owner is a human participant; seed one only if room creation did not
  // create it, then require exactly one identity before executing lifecycle RPCs.
  let ownerParticipants = await request(
    "/rest/v1/participants?select=id,kind,user_id&room_id=eq." + room.id + "&user_id=eq." + owner.id,
  );
  if (ownerParticipants.length === 0) {
    ownerParticipants = await request("/rest/v1/participants", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        room_id: room.id, user_id: owner.id, display_name: "Room owner",
        kind: "human", status: "connected",
      }),
    });
  }
  assert.equal(ownerParticipants.length, 1, "the room owner must have exactly one human participant identity");
  assert.equal(ownerParticipants[0].kind, "human");

  const proposalArgs = {
    session_handle: one.session_handle,
    title: "CI end-to-end group task",
    description: "Verify a real task can move through the human-governed MCP lifecycle.",
    expected_output: "A completed task, one submission, and one human approval.",
    acceptance_criteria: ["The assigned AI claims the task", "The AI submits a result", "The owner approves the result"],
    priority: 2,
    idempotency_key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  };
  const proposed = await first.callTool({ name: "propose_group_task", arguments: proposalArgs });
  assert.notEqual(proposed.isError, true, "AI task proposal failed: " + JSON.stringify(proposed));
  assert.equal(proposed.structuredContent?.proposed, true);
  const taskId = proposed.structuredContent?.task?.id || proposed.structuredContent?.task_id;
  assert.match(taskId || "", /^[0-9a-f-]{36}$/i, "AI proposal must return a task UUID");
  assert.equal(proposed.structuredContent?.task?.status || proposed.structuredContent?.status, "backlog",
    "AI proposal must begin in backlog before a human approves assignment");
  const proposalRetry = await first.callTool({ name: "propose_group_task", arguments: proposalArgs });
  assert.notEqual(proposalRetry.isError, true, "same task proposal retry must succeed: " + JSON.stringify(proposalRetry));
  assert.equal(proposalRetry.structuredContent?.replayed, true, "same proposal retry must be idempotent");
  assert.equal(proposalRetry.structuredContent?.task_id || proposalRetry.structuredContent?.task?.id, taskId,
    "proposal retry must return the original task ID");

  const listedBySecondAi = await second.callTool({
    name: "list_group_tasks",
    arguments: { session_handle: two.session_handle },
  });
  assert.notEqual(listedBySecondAi.isError, true, "second AI could not list group tasks");
  assert.ok(listedBySecondAi.structuredContent?.tasks?.some(task => task.id === taskId),
    "a task proposal must be visible to the other AI in the same group");

  const unassignedClaim = await second.callTool({
    name: "claim_group_task",
    arguments: { session_handle: two.session_handle, task_id: taskId },
  });
  assert.equal(unassignedClaim.isError, true, "AI participants must not claim an unassigned proposal");

  const assigned = await ownerRequest("/rest/v1/rpc/assign_room_task", {
    method: "POST",
    body: JSON.stringify({
      p_room_id: room.id,
      p_task_id: taskId,
      p_assigned_to_participant_id: one.participant_id,
    }),
  });
  assert.equal(assigned.assigned, true, "human owner must be able to assign the proposed task");
  assert.equal(assigned.status, "assigned");

  const wrongAssigneeClaim = await second.callTool({
    name: "claim_group_task",
    arguments: { session_handle: two.session_handle, task_id: taskId },
  });
  assert.equal(wrongAssigneeClaim.isError, true, "a different AI must not claim work assigned to AI one");

  const claimed = await first.callTool({
    name: "claim_group_task",
    arguments: { session_handle: one.session_handle, task_id: taskId },
  });
  assert.notEqual(claimed.isError, true, "the assigned AI could not claim its task: " + JSON.stringify(claimed));
  assert.equal(claimed.structuredContent?.claimed, true);
  assert.equal(claimed.structuredContent?.status, "in_progress");

  const submitted = await first.callTool({
    name: "submit_group_task_result",
    arguments: {
      session_handle: one.session_handle,
      task_id: taskId,
      result: "The task was completed by the assigned AI and is ready for owner review.",
      submission_key: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    },
  });
  assert.notEqual(submitted.isError, true, "assigned AI could not submit its result: " + JSON.stringify(submitted));
  assert.equal(submitted.structuredContent?.submitted, true);
  assert.equal(submitted.structuredContent?.status, "review");
  assert.ok(submitted.structuredContent?.submission_id);

  const resultRows = await request(
    "/rest/v1/room_task_submissions?select=id,task_id,submitted_by_participant_id&task_id=eq." + taskId,
  );
  assert.equal(resultRows.length, 1, "one task submission must be persisted");

  const review = await ownerRequest("/rest/v1/rpc/review_room_task", {
    method: "POST",
    body: JSON.stringify({
      p_room_id: room.id,
      p_task_id: taskId,
      p_outcome: "approved",
      p_feedback: "Accepted by the human room owner in the official MCP SDK end-to-end test.",
      p_criterion_evidence: [
        { criterion: "The assigned AI claims the task", met: true, evidence: "The assigned AI claim RPC returned in_progress for the expected participant." },
        { criterion: "The AI submits a result", met: true, evidence: "The official MCP SDK submission created exactly one persisted task submission." },
        { criterion: "The owner approves the result", met: true, evidence: "The human owner review RPC returned completed after this approval." },
      ],
    }),
  });
  assert.equal(review.reviewed, true, "human room owner must be able to review the submitted task");
  assert.equal(review.status, "completed", "approved task must transition to completed");
  const persistedReviewEvidence = await request(
    "/rest/v1/room_task_reviews?select=criterion_evidence&task_id=eq." + taskId,
  );
  assert.equal(persistedReviewEvidence.length, 1, "one human review must be persisted");
  assert.equal(persistedReviewEvidence[0].criterion_evidence.length, 3, "all task criteria must retain review evidence");

  const completedTask = await first.callTool({
    name: "read_group_task",
    arguments: { session_handle: one.session_handle, task_id: taskId },
  });
  assert.notEqual(completedTask.isError, true, "AI could not read the approved task");
  assert.equal(completedTask.structuredContent?.task?.status, "completed");
  assert.equal(completedTask.structuredContent?.submissions?.length, 1);
  assert.equal(completedTask.structuredContent?.reviews?.length, 1);
  const submissionRetry = await first.callTool({
    name: "submit_group_task_result",
    arguments: {
      session_handle: one.session_handle,
      task_id: taskId,
      result: "The task was completed by the assigned AI and is ready for owner review.",
      submission_key: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    },
  });
  assert.notEqual(submissionRetry.isError, true, "submission retry must remain idempotent after approval");
  assert.equal(submissionRetry.structuredContent?.replayed, true);
  console.log("SAFE_MCP_E2E_STAGE: human-governed task lifecycle passed");

  // Revoke AI two outside the MCP session while keeping its opaque MCP
  // handle alive. A new invite on that same handle must clear the old private
  // cursor before it can bind to the new participant.
  const secondSessionDigest = createHash("sha256").update(two.session_handle, "utf8").digest("hex");
  const previousCursorState = await second.callTool({
    name: "save_original_session_bridge_state",
    arguments: {
      session_handle: two.session_handle,
      expected_revision: isolatedState.structuredContent.revision,
      cursor_created_at: stateMessage.created_at,
      cursor_message_id: stateMessage.id,
      pending_message_id: null,
      pending_message_created_at: null,
      pending_response: null,
      blocked_message_id: null,
      blocked_reason: null,
    },
  });
  assert.notEqual(previousCursorState.isError, true, "could not seed stale cursor for revoked-session rejoin");
  assert.equal(previousCursorState.structuredContent?.saved, true);
  const oldConnectionRows = await request(
    "/rest/v1/agent_connections?select=id,participant_id,revoked_at,credential_digest&participant_id=eq." + two.participant_id,
  );
  assert.equal(oldConnectionRows.length, 1);
  const staleRejoinToken = "9".repeat(64);
  await request("/rest/v1/room_invites", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      room_id: room.id,
      created_by: owner.id,
      token_hash: createHash("sha256").update(staleRejoinToken, "utf8").digest("hex"),
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      max_uses: 1,
      uses: 0,
      allow_ai: true,
      max_ai_uses: 1,
      ai_uses: 0,
    }),
  });
  const revokedOldConnection = await request(
    "/rest/v1/agent_connections?id=eq." + oldConnectionRows[0].id,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ revoked_at: new Date().toISOString() }),
    },
  );
  assert.equal(revokedOldConnection.length, 1);
  assert.ok(revokedOldConnection[0].revoked_at);
  const rebound = await second.callTool({
    name: "join_group",
    arguments: {
      session_handle: two.session_handle,
      invite_token: staleRejoinToken,
      agent_label: "Official SDK AI two rebound",
      confirm_join: true,
      join_request_key: "c".repeat(64),
    },
  });
  assert.notEqual(rebound.isError, true, "same MCP handle could not rejoin after its previous AI credential was revoked: " + JSON.stringify(rebound));
  assert.equal(rebound.structuredContent?.joined, true);
  assert.equal(rebound.structuredContent?.session_handle, two.session_handle,
    "a rebind must preserve the already-issued MCP session handle");
  assert.notEqual(rebound.structuredContent?.participant_id, two.participant_id,
    "rejoining after external credential revocation must establish a fresh participant binding");
  const reboundRetry = await second.callTool({
    name: "join_group",
    arguments: {
      session_handle: two.session_handle,
      invite_token: staleRejoinToken,
      agent_label: "Official SDK AI two rebound",
      confirm_join: true,
      join_request_key: "c".repeat(64),
    },
  });
  assert.notEqual(reboundRetry.isError, true,
    "retrying the same rebind request must return the already-established participant");
  assert.equal(reboundRetry.structuredContent?.participant_id, rebound.structuredContent?.participant_id,
    "retrying the same rebind request must not create another AI participant");
  const staleBridgeStateAfterRejoin = await request(
    "/rest/v1/rub_minds_mcp_bridge_state?select=session_digest,participant_id&session_digest=eq." + secondSessionDigest,
  );
  assert.deepEqual(staleBridgeStateAfterRejoin, [],
    "rejoining after credential revocation must delete the previous participant's durable cursor before rebinding");
  const reboundConnectionRows = await request(
    "/rest/v1/agent_connections?select=id,participant_id,revoked_at,credential_digest&room_id=eq." + room.id,
  );
  const oldRejoinConnection = reboundConnectionRows.find(row => row.id === oldConnectionRows[0].id);
  const freshRejoinConnection = reboundConnectionRows.find(row => row.participant_id === rebound.structuredContent.participant_id);
  assert.ok(oldRejoinConnection?.revoked_at);
  assert.ok(freshRejoinConnection && freshRejoinConnection.revoked_at === null,
    "the rejoined participant must have a fresh active agent connection");
  assert.notEqual(freshRejoinConnection.credential_digest, oldRejoinConnection.credential_digest,
    "the new provider credential must have a distinct digest from the revoked credential");

  // Prove the atomic termination RPC rejects a stale ciphertext snapshot
  // without revoking the live connection, tombstoning the session, or deleting
  // its private bridge state.
  const firstSessionDigestForTermination = createHash("sha256")
    .update(one.session_handle, "utf8").digest("hex");
  const beforeTermination = await request(
    "/rest/v1/rub_minds_mcp_sessions?select=session_digest,agent_credential_ciphertext,terminated_at&session_digest=eq." +
      firstSessionDigestForTermination,
  );
  assert.equal(beforeTermination.length, 1);
  assert.equal(beforeTermination[0].terminated_at, null);
  assert.equal(typeof beforeTermination[0].agent_credential_ciphertext, "string");
  const staleTermination = await request("/rest/v1/rpc/terminate_rub_minds_mcp_bridge_session", {
    method: "POST",
    body: JSON.stringify({
      p_session_digest: firstSessionDigestForTermination,
      p_expected_ciphertext: "stale-ciphertext-snapshot",
      p_credential_digest: "f".repeat(64),
      p_tombstone_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }),
  });
  assert.equal(staleTermination?.conflict, true,
    "atomic termination must reject an outdated session ciphertext snapshot");
  assert.equal(staleTermination?.terminated, false);
  const unchangedAfterStaleTermination = await request(
    "/rest/v1/rub_minds_mcp_sessions?select=agent_credential_ciphertext,terminated_at&session_digest=eq." +
      firstSessionDigestForTermination,
  );
  assert.equal(unchangedAfterStaleTermination[0].agent_credential_ciphertext,
    beforeTermination[0].agent_credential_ciphertext,
    "a stale termination attempt must leave the current session binding intact");
  assert.equal(unchangedAfterStaleTermination[0].terminated_at, null);
  const bridgeStateAfterStaleTermination = await request(
    "/rest/v1/rub_minds_mcp_bridge_state?select=session_digest&session_digest=eq." +
      firstSessionDigestForTermination,
  );
  assert.equal(bridgeStateAfterStaleTermination.length, 1,
    "stale termination must not delete current bridge state");

  // Race leave against an idempotent retry of the same join. Either the retry
  // observes the active join before leave wins, or it is rejected as revoked;
  // the invariant is that the old handle must be unusable after both finish.
  const [left, racingJoin, racingBridgeStateLoad, racingBridgeStateSave] = await Promise.all([
    first.callTool({
      name: "leave_group",
      arguments: { session_handle: one.session_handle, confirm_leave: true },
    }),
    first.callTool({
      name: "join_group",
      arguments: {
        session_handle: one.session_handle,
        invite_token: inviteToken,
        agent_label: "Official SDK AI one",
        confirm_join: true,
        join_request_key: "d".repeat(64),
      },
    }),
    first.callTool({
      name: "load_original_session_bridge_state",
      arguments: { session_handle: one.session_handle },
    }),
    first.callTool({
      name: "save_original_session_bridge_state",
      arguments: {
        session_handle: one.session_handle,
        expected_revision: bridgeSave.structuredContent.revision,
        cursor_created_at: stateMessage.created_at,
        cursor_message_id: stateMessage.id,
        pending_message_id: null,
        pending_message_created_at: null,
        pending_response: null,
        blocked_message_id: null,
        blocked_reason: null,
      },
    }),
  ]);
  assert.notEqual(left.isError, true, "official SDK client could not leave and revoke its session: " + JSON.stringify(left));
  assert.ok(
    racingBridgeStateLoad.isError === true ||
      Number.isSafeInteger(racingBridgeStateLoad.structuredContent?.revision),
    "a bridge-state load racing with leave must either finish before termination or be rejected after tombstoning",
  );
  assert.ok(
    racingBridgeStateSave.isError === true ||
      racingBridgeStateSave.structuredContent?.saved === true ||
      racingBridgeStateSave.structuredContent?.conflict === true,
    "a bridge-state save racing with leave must either complete before termination, return a CAS conflict, or fail after tombstoning",
  );
  assert.ok(
    racingJoin.isError === true || racingJoin.structuredContent?.joined === true,
    "concurrent retry must either be rejected or return the already-joined session: " + JSON.stringify(racingJoin),
  );
  const deniedAfterRace = await first.callTool({
    name: "read_group_messages",
    arguments: { session_handle: one.session_handle },
  });
  assert.equal(deniedAfterRace.isError, true, "a concurrent join retry must not resurrect a session after leave");

  const firstSessionDigest = createHash("sha256").update(one.session_handle, "utf8").digest("hex");
  const terminatedSessions = await request(
    "/rest/v1/rub_minds_mcp_sessions?select=session_digest,participant_id,terminated_at,agent_credential_digest&session_digest=eq." + firstSessionDigest,
  );
  assert.equal(terminatedSessions.length, 1, "leaving must retain the session tombstone by its digest");
  assert.ok(terminatedSessions[0].terminated_at, "leaving must mark the session as terminated");
  assert.equal(terminatedSessions[0].participant_id, null, "a tombstoned session must no longer be bound to a participant");
  assert.equal(terminatedSessions[0].agent_credential_digest, null, "Leave must clear the AI credential digest together with its encrypted credential");
  const frameBindingAfterLeave = await request(
    "/rest/v1/backroom_device_frame_bindings?select=id,revoked_at&challenge_id=eq." + frameChallengeIdFromOwner,
  );
  assert.equal(frameBindingAfterLeave.length, 1);
  assert.ok(frameBindingAfterLeave[0].revoked_at,
    "leaving the group must revoke the exact AI session device-frame association");
  const residualBridgeState = await request(
    "/rest/v1/rub_minds_mcp_bridge_state?select=session_digest&session_digest=eq." + firstSessionDigest,
  );
  assert.deepEqual(residualBridgeState, [], "leaving must delete private original-session cursor and pending-response state");

  const participants = await request(
    "/rest/v1/participants?select=id,kind&room_id=eq." + room.id + "&kind=eq.external_agent",
  );
  assert.equal(participants.length, 3, "two original participants plus one fresh rejoin participant must be present");
  const connections = await request("/rest/v1/agent_connections?select=id,participant_id,revoked_at&room_id=eq." + room.id);
  assert.equal(connections.length, 3, "both original credentials plus one fresh rejoin credential must be present");
  const firstConnection = connections.find(connection => connection.participant_id === one.participant_id);
  assert.ok(firstConnection?.revoked_at, "leaving must revoke the first AI credential even when join retries race with leave");
  console.log("SAFE_MCP_E2E_STAGE: full official MCP SDK collaboration and leave/rejoin lifecycle passed");
} finally {
  await Promise.allSettled([first.close(), second.close()]);
}
