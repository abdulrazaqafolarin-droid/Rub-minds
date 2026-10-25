#!/usr/bin/env node
/**
 * End-to-end interoperability test using the official MCP TypeScript client
 * against the disposable local Supabase Edge Function.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

  const catalog = await first.listTools();
  const names = catalog.tools.map(tool => tool.name);
  assert.ok(names.includes("join_group"), "official client did not discover join_group");
  assert.ok(names.includes("leave_group"), "official client did not discover leave_group");
  assert.ok(names.includes("send_group_message"), "official client did not discover send_group_message");
  assert.ok(names.includes("read_group_messages"), "official client did not discover read_group_messages");
  assert.ok(names.includes("wait_for_group_messages"), "official client did not discover wait_for_group_messages");

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
  console.log("Official MCP SDK rejected expired, revoked, human-only, and unconfirmed AI invitations.");

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

  // Prove the MCP tool can wait on a real Supabase Realtime Postgres Changes
  // subscription. Delay the second client's send so the first subscription is
  // established; a timeout or unavailable subscription must fail this test.
  const realtimeCursor = new Date().toISOString();
  const waitingForRealtime = first.callTool({
    name: "wait_for_group_messages",
    arguments: {
      session_handle: one.session_handle,
      after_created_at: realtimeCursor,
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
  assert.equal(realtimeRead.structuredContent?.timed_out, false, "Realtime wait timed out instead of waking on a new message");
  assert.equal(realtimeRead.structuredContent?.delivery, "realtime", "message was not delivered through the Realtime subscription");
  assert.ok(
    realtimeRead.structuredContent?.messages?.some(message => message.body === realtimeBody),
    "waiting AI did not retrieve the message that woke its Realtime subscription",
  );
  console.log("Official MCP SDK received a new group message through the bounded Supabase Realtime wait.");

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
  console.log("Official MCP SDK enforced the AI invitation quota without creating an extra participant.");

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
    "AI one must retain access to its own private memory",
  );
  assert.ok(
    !memoryTwo.structuredContent?.group_memory?.some(entry => entry.content.includes("PRIVATE ONLY")),
    "AI two must not see AI one's private memory",
  );
  assert.ok(
    memoryTwo.structuredContent?.group_memory?.some(entry => entry.visibility === "group" && entry.content.includes("SHARED DECISION")),
    "AI two must see explicitly group-shared memory",
  );
  console.log("Official MCP SDK private session-context and explicit group-memory isolation passed.");

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
  console.log("MCP message retry idempotency passed: one source ID, one persisted message.");

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
  const publicKey = process.env.LOCAL_SUPABASE_ANON_KEY;
  assert.ok(publicKey, "local publishable/anon key is required for human RLS checks");
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
  console.log("Authenticated human and MCP AI exchanged messages in both directions; outsider RLS denied room access.");

  // Seed a real cursor and private pending answer for the first session so
  // leaving proves that sensitive durable bridge state is removed with revocation.
  const seededBridgeState = await first.callTool({
    name: "load_original_session_bridge_state",
    arguments: { session_handle: one.session_handle },
  });
  assert.notEqual(seededBridgeState.isError, true,
    "could not initialize bridge state before leave: " + JSON.stringify(seededBridgeState));
  const latestGroupMessages = await request(
    "/rest/v1/messages?select=id,created_at&room_id=eq." + room.id + "&order=created_at.desc&limit=1",
  );
  assert.equal(latestGroupMessages.length, 1,
    "a persisted group message is required to exercise bridge-state cleanup");
  const pendingFixture = latestGroupMessages[0];
  const seededStateSave = await first.callTool({
    name: "save_original_session_bridge_state",
    arguments: {
      session_handle: one.session_handle,
      expected_revision: seededBridgeState.structuredContent.revision,
      cursor_created_at: pendingFixture.created_at,
      cursor_message_id: pendingFixture.id,
      pending_message_id: pendingFixture.id,
      pending_message_created_at: pendingFixture.created_at,
      pending_response: "Private pending response used to verify cleanup",
      blocked_message_id: null,
      blocked_reason: null,
    },
  });
  assert.notEqual(seededStateSave.isError, true,
    "could not persist private bridge state before leave: " + JSON.stringify(seededStateSave));
  assert.equal(seededStateSave.structuredContent?.saved, true,
    "bridge state fixture did not persist");
  const firstSessionDigestBeforeLeave = createHash("sha256").update(one.session_handle, "utf8").digest("hex");
  const bridgeStateBeforeLeave = await request(
    "/rest/v1/rub_minds_mcp_bridge_state?select=session_digest,cursor_message_id,pending_response&session_digest=eq." + firstSessionDigestBeforeLeave,
  );
  assert.equal(bridgeStateBeforeLeave.length, 1,
    "bridge state should exist before revocation so cleanup is exercised");
  assert.equal(bridgeStateBeforeLeave[0].cursor_message_id, pendingFixture.id);
  assert.equal(bridgeStateBeforeLeave[0].pending_response, "Private pending response used to verify cleanup");

  // Race leave against an idempotent retry of the same join. Either the retry
  // observes the active join before leave wins, or it is rejected as revoked;
  // the invariant is that the old handle must be unusable after both finish.
  const [left, racingJoin] = await Promise.all([
    first.callTool({
      name: "leave_group",
      arguments: { session_handle: one.session_handle, confirm_leave: true },
    }),
    first.callTool({
      name: "join_group",
      arguments: {
        invite_token: inviteToken,
        agent_label: "Official SDK AI one",
        confirm_join: true,
        join_request_key: "a".repeat(64),
      },
    }),
  ]);
  assert.notEqual(left.isError, true, "official SDK client could not leave and revoke its session: " + JSON.stringify(left));
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
    "/rest/v1/rub_minds_mcp_sessions?select=session_digest,participant_id,terminated_at&session_digest=eq." + firstSessionDigest,
  );
  assert.equal(terminatedSessions.length, 1, "leaving must retain the session tombstone by its digest");
  assert.ok(terminatedSessions[0].terminated_at, "leaving must mark the session as terminated");
  assert.equal(terminatedSessions[0].participant_id, null, "a tombstoned session must no longer be bound to a participant");
  const residualBridgeState = await request(
    "/rest/v1/rub_minds_mcp_bridge_state?select=session_digest&session_digest=eq." + firstSessionDigest,
  );
  assert.deepEqual(residualBridgeState, [],
    "leaving must delete durable cursor/pending-response state for the revoked session");
  const participants = await request(
    "/rest/v1/participants?select=id,kind&room_id=eq." + room.id + "&kind=eq.external_agent",
  );
  assert.equal(participants.length, 2, "official SDK clients must create exactly two AI participants");
  const connections = await request("/rest/v1/agent_connections?select=id,participant_id,revoked_at&room_id=eq." + room.id);
  assert.equal(connections.length, 2, "both official SDK clients must have scoped connections");
  const firstConnection = connections.find(connection => connection.participant_id === one.participant_id);
  assert.ok(firstConnection?.revoked_at, "leaving must revoke the first AI credential even when join retries race with leave");
  console.log("Official MCP SDK interoperability passed: discovery, tool catalog, two AI joins, shared message relay, and credential revocation.");
} finally {
  await Promise.allSettled([first.close(), second.close()]);
}
