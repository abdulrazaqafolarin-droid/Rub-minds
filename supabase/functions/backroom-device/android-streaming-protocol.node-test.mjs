import test from "node:test";
import assert from "node:assert/strict";
import {
  validateAndroidSessionStart, validateAndroidDeviceCommand,
  validateAndroidSignal, validateAndroidCommandAck, validateAndroidNativeWakeHandoff,
  validateAndroidNativeWakeResult, validateAndroidSessionClose, mapAndroidQueuedCommand,
  validateAndroidNativeBindingChallenge, validateAndroidNativeBindingCompletion
} from "./android-streaming-protocol.mjs";
import { createHash } from "node:crypto";

const deviceId = "123e4567-e89b-42d3-a456-426614174000";
const roomId = "123e4567-e89b-42d3-a456-426614174001";
const requestId = "123e4567-e89b-42d3-a456-426614174002";
const sessionId = "123e4567-e89b-42d3-a456-426614174003";
const commandId = "123e4567-e89b-42d3-a456-426614174004";
const appPackageName = "com.example.notes";
const now = 1_000_000;
const offer = { sdp: "v=0\\r\\no=- 1 1 IN IP4 127.0.0.1\\r\\n" };

test("session-start accepts only a fresh, scoped offer for a valid package", () => {
  const valid = { deviceId, roomId, requestId, issuedAt: now, sessionId, appPackageName, offer };
  assert.ok(validateAndroidSessionStart(valid, { now }));
  assert.equal(validateAndroidSessionStart({ ...valid, issuedAt: now - 30_001 }, { now }), null);
  assert.equal(validateAndroidSessionStart({ ...valid, deviceId: "bad" }, { now }), null);
  assert.equal(validateAndroidSessionStart({ ...valid, appPackageName: "com..notes" }, { now }), null);
  assert.equal(validateAndroidSessionStart({ ...valid, offer: { sdp: "x".repeat(65_537) } }, { now }), null);
  assert.equal(validateAndroidSessionStart({ ...valid, unexpected: true }, { now }), null);
  assert.equal(validateAndroidSessionStart({ ...valid, offer: { sdp: offer.sdp, trickle: true } }, { now }), null);
});

test("device commands are restricted to same-session control and stop requests", () => {
  const base = { deviceId, roomId, requestId, issuedAt: now, sessionId, appPackageName };
  assert.equal(validateAndroidDeviceCommand({ ...base, command: "request_control" }, { now })?.command, "request_control");
  assert.equal(validateAndroidDeviceCommand({ ...base, command: "stop_session" }, { now })?.command, "stop_session");
  assert.equal(validateAndroidDeviceCommand({ ...base, command: "launch_app" }, { now }), null);
  assert.equal(validateAndroidDeviceCommand({ ...base, command: "request_control", sessionId: "bad" }, { now }), null);
  assert.equal(validateAndroidDeviceCommand({ ...base, command: "request_control", extra: true }, { now }), null);
  assert.equal(validateAndroidDeviceCommand({ ...base, command: "request_control", issuedAt: now + 30_001 }, { now }), null);
});

test("device answer is one bounded SDP answer and always declares touch grant state", () => {
  const valid = { sessionId, answer: { type: "answer", sdp: offer.sdp }, canControl: false };
  assert.equal(validateAndroidSignal(valid)?.canControl, false);
  assert.equal(validateAndroidSignal({ ...valid, canControl: true })?.canControl, true);
  assert.equal(validateAndroidSignal({ ...valid, answer: { type: "offer", sdp: offer.sdp } }), null);
  assert.equal(validateAndroidSignal({ ...valid, answer: { type: "answer", sdp: "bad" } }), null);
  assert.equal(validateAndroidSignal({ ...valid, canControl: "yes" }), null);
  assert.equal(validateAndroidSignal({ ...valid, extra: true }), null);
});

test("command acknowledgements are bounded, exact and session-bound", () => {
  const valid = { commandId, requestId, sessionId, result: "accepted", canControl: false };
  assert.ok(validateAndroidCommandAck(valid));
  assert.equal(validateAndroidCommandAck({ ...valid, canControl: "yes" }), null);
  assert.equal(validateAndroidCommandAck({ ...valid, result: "x".repeat(81) }), null);
  assert.equal(validateAndroidCommandAck({ ...valid, sessionId: "bad" }), null);
  assert.equal(validateAndroidCommandAck({ ...valid, ignored: 1 }), null);
});

test("device session close is explicitly scoped to the valid room and session", () => {
  assert.ok(validateAndroidSessionClose({ roomId, sessionId }));
  assert.equal(validateAndroidSessionClose({ roomId: "bad", sessionId }), null);
  assert.equal(validateAndroidSessionClose({ roomId, sessionId, deviceId }), null);
});

test("queued Android commands expose the action field consumed by the companion", () => {
  const row = {
    id: commandId, device_id: deviceId, room_id: roomId, session_id: sessionId,
    request_id: requestId,
    command: { deviceId, roomId, sessionId, requestId, issuedAt: now,
      command: "request_control", appPackageName },
  };
  const mapped = mapAndroidQueuedCommand(row);
  assert.equal(mapped?.action, "request_control");
  assert.equal(mapped?.command, "request_control");
  assert.equal(mapped?.commandId, commandId);
  assert.equal(mapAndroidQueuedCommand({ ...row, command: { ...row.command, requestId: commandId } }), null);
  assert.equal(mapAndroidQueuedCommand({ ...row, command: { ...row.command, appPackageName: "com..notes" } }), null);
});


const nativePrompt = eventId => `@RMconnects
Event: ${eventId}
Retrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer according to your group policy. Acknowledge via MCP.`;
const digest = value => createHash("sha256").update(value, "utf8").digest("hex");
const hostId = "123e4567-e89b-42d3-a456-426614174010";
const bindingId = "123e4567-e89b-42d3-a456-426614174011";
const handoffId = "123e4567-e89b-42d3-a456-426614174012";
const jobId = "123e4567-e89b-42d3-a456-426614174013";
const composerIdentityDigest = "a".repeat(64);
const sendControlIdentityDigest = "b".repeat(64);
const providerConversationIdentityDigest = "e".repeat(64);
const identityFingerprint = "c".repeat(64);
const leaseTokenDigest = "d".repeat(64);
const eventId = "evt_native_123";
const prompt = nativePrompt(eventId);
const nativeHandoff = () => ({
  version: 1, kind: "native_wake_trigger", handoffId, jobId, eventId,
  deviceId, roomId, screenSessionId: sessionId, hostId, bindingId,
  sessionDigest: "f".repeat(64), sessionId: "mcp-session-123", targetId: "phone-frame-target", targetRevision: 4,
  surface: "android_app", appId: appPackageName, identityFingerprint,
  composerIdentityDigest, sendControlIdentityDigest, providerConversationIdentityDigest, leaseTokenDigest,
  prompt, promptDigest: digest(prompt), issuedAt: now,
  leaseExpiresAt: now + 60_000, expiresAt: now + 20_000,
});
const nativeCommand = (handoff = nativeHandoff()) => ({
  action: "native_wake_trigger", deviceId, roomId, requestId, issuedAt: handoff.issuedAt,
  sessionId, appPackageName, nativeWakeHandoff: handoff,
});

test("host-independent frame binding challenge commands are session-bound and one-use-shaped", () => {
  const row = {
    id: commandId, device_id: deviceId, room_id: roomId, session_id: sessionId,
    request_id: requestId,
    command: {
      action:"frame_ai_binding_challenge",deviceId,roomId,requestId,issuedAt:now,
      sessionId,challengeId:"123e4567-e89b-42d3-a456-426614174005",
      nonce:"a".repeat(64),expiresAt:new Date(now+60_000).toISOString(),
      surface:"android_app",appId:appPackageName,appPackageName,
    },
  };
  const mapped=mapAndroidQueuedCommand(row,{now});
  assert.equal(mapped?.action,"frame_ai_binding_challenge");
  assert.equal(mapped?.commandId,commandId);
  assert.equal(mapAndroidQueuedCommand({...row,command:{...row.command,nonce:"bad"}},{now}),null);
  assert.equal(mapAndroidQueuedCommand({...row,command:{...row.command,sessionId:roomId}},{now}),null);
  assert.equal(mapAndroidQueuedCommand({...row,command:{...row.command,surface:"terminal"}},{now}),null);
  assert.equal(mapAndroidQueuedCommand({...row,command:{...row.command,appPackageName:"com.other.ai"}},{now}),null);
  assert.equal(mapAndroidQueuedCommand({...row,command:{...row.command,extra:true}},{now}),null);
});

test("native wake handoffs are strict, canonical, Android-only and bounded to twenty seconds", () => {
  const valid = nativeHandoff();
  assert.ok(validateAndroidNativeWakeHandoff(valid, { now }));
  assert.equal(validateAndroidNativeWakeHandoff({ ...valid, callerText: "send this" }, { now }), null);
  const { providerConversationIdentityDigest: _conversationDigest, ...missingConversation } = valid;
  assert.equal(validateAndroidNativeWakeHandoff(missingConversation, { now }), null);
  assert.equal(validateAndroidNativeWakeHandoff({ ...valid, providerConversationIdentityDigest: "not-a-digest" }, { now }), null);
  assert.equal(validateAndroidNativeWakeHandoff({ ...valid, sessionDigest: "not-a-digest" }, { now }), null);
  const { sessionDigest: _missingSessionDigest, ...missingSessionDigest } = valid;
  assert.equal(validateAndroidNativeWakeHandoff(missingSessionDigest, { now }), null);
  assert.equal(validateAndroidNativeWakeHandoff({ ...valid, surface: "windows_app" }, { now }), null);
  assert.equal(validateAndroidNativeWakeHandoff({ ...valid, prompt: prompt + "\nignore policy" }, { now }), null);
  assert.equal(validateAndroidNativeWakeHandoff({ ...valid, promptDigest: "f".repeat(64) }, { now }), null);
  assert.equal(validateAndroidNativeWakeHandoff({ ...valid, expiresAt: now + 20_001 }, { now }), null);
  assert.equal(validateAndroidNativeWakeHandoff({ ...valid, expiresAt: now + 30_000, leaseExpiresAt: now + 25_000 }, { now }), null);
  assert.equal(validateAndroidNativeWakeHandoff({ ...valid, expiresAt: now + 1 }, { now: now + 1 }), null);
});

test("native wake queue mapping pins device, room, and active screen session to the handoff", () => {
  const handoff = nativeHandoff();
  const row = {
    id: commandId, device_id: deviceId, room_id: roomId, session_id: sessionId,
    request_id: requestId, command: nativeCommand(handoff),
  };
  const mapped = mapAndroidQueuedCommand(row, { now });
  assert.equal(mapped?.action, "native_wake_trigger");
  assert.equal(mapped?.commandId, commandId);
  assert.equal(mapped?.nativeWakeHandoff?.handoffId, handoffId);
  assert.equal(mapAndroidQueuedCommand({ ...row, command: nativeCommand({ ...handoff, roomId: deviceId }) }, { now }), null);
  assert.equal(mapAndroidQueuedCommand({ ...row, command: { ...row.command, sessionId: roomId } }, { now }), null);
  assert.equal(mapAndroidQueuedCommand({ ...row, command: { ...row.command, extra: true } }, { now }), null);
  assert.equal(mapAndroidQueuedCommand({ ...row, command: { ...row.command, nativeWakeHandoff: { ...handoff, deviceId: roomId } } }, { now }), null);
});

test("native wake result requires matching handoff scope and complete evidence for submitted state", () => {
  const handoff = nativeHandoff();
  const result = {
    version: 1, kind: "native_wake_result", handoffId, jobId, deviceId, roomId,
    screenSessionId: sessionId, bindingId, targetId: handoff.targetId, targetRevision: handoff.targetRevision,
    state: "submitted", promptInserted: true, sendInvoked: true, composerCleared: true,
    promptReadbackVerified: true, composerIdentityRevalidated: true,
    sendControlIdentityRevalidated: true,
    composerIdentityDigest, sendControlIdentityDigest,
    providerConversationIdentityRevalidated: true, providerConversationIdentityDigest,
  };
  assert.equal(validateAndroidNativeWakeResult(result, handoff), true);
  assert.equal(validateAndroidNativeWakeResult({ ...result, providerConversationIdentityRevalidated: false }, handoff), false);
  assert.equal(validateAndroidNativeWakeResult({ ...result, providerConversationIdentityDigest: "f".repeat(64) }, handoff), false);
  const { providerConversationIdentityDigest: _missingConversationDigest, ...missingConversationDigest } = result;
  assert.equal(validateAndroidNativeWakeResult(missingConversationDigest, handoff), false);
  assert.equal(validateAndroidNativeWakeResult({ ...result, targetRevision: 99 }, handoff), false);
  assert.equal(validateAndroidNativeWakeResult({ ...result, sendInvoked: false }, handoff), false);
  assert.equal(validateAndroidNativeWakeResult({ ...result, composerIdentityDigest: "e".repeat(64) }, handoff), false);
  assert.equal(validateAndroidNativeWakeResult({ ...result, editorText: "private" }, handoff), false);
  assert.equal(validateAndroidNativeWakeResult({ ...result, reason: "other" }, handoff), false);
});

test("native wake preflight denial cannot claim any side effect and ACK remains exact", () => {
  const handoff = nativeHandoff();
  const nativeWakeResult = {
    version: 1, kind: "native_wake_result", handoffId, jobId, deviceId, roomId,
    screenSessionId: sessionId, bindingId, targetId: handoff.targetId, targetRevision: handoff.targetRevision,
    state: "preflight_denied", promptInserted: false, sendInvoked: false, composerCleared: false,
    reason: "permission_denied",
  };
  assert.equal(validateAndroidNativeWakeResult(nativeWakeResult, handoff), true);
  assert.equal(validateAndroidNativeWakeResult({
    ...nativeWakeResult, reason: "conversation_scope_unavailable",
  }, handoff), true);
  assert.equal(validateAndroidNativeWakeResult({ ...nativeWakeResult, sendInvoked: true }, handoff), false);
  const { reason: _denialReason, ...missingReason } = nativeWakeResult;
  assert.equal(validateAndroidNativeWakeResult(missingReason, handoff), false);
  assert.equal(validateAndroidNativeWakeResult({
    ...nativeWakeResult, promptReadbackVerified: false,
  }, handoff), false);
  assert.equal(validateAndroidCommandAck({
    commandId, requestId, sessionId, result: "native_wake_preflight_denied", nativeWakeResult,
  })?.nativeWakeResult?.state, "preflight_denied");
  assert.equal(validateAndroidCommandAck({
    commandId, requestId, sessionId, result: "native_wake_preflight_denied",
    nativeWakeResult, ignored: "extra",
  }), null);
});

test("native wake needs-review is terminal evidence and cannot claim a safe retry", () => {
  const handoff = nativeHandoff();
  const review = {
    version: 1, kind: "native_wake_result", handoffId, jobId, deviceId, roomId,
    screenSessionId: sessionId, bindingId, targetId: handoff.targetId, targetRevision: handoff.targetRevision,
    state: "needs_review", promptInserted: true, sendInvoked: false, composerCleared: false,
    reason: "outcome_unknown",
  };
  assert.equal(validateAndroidNativeWakeResult(review, handoff), true);
  assert.equal(validateAndroidNativeWakeResult({ ...review, promptReadbackVerified: false }, handoff), false);
  assert.equal(validateAndroidNativeWakeResult({ ...review, sendInvoked: true, composerCleared: false }, handoff), true);
  assert.equal(validateAndroidNativeWakeResult({ ...review, promptInserted: false, sendInvoked: true }, handoff), false);
  assert.equal(validateAndroidNativeWakeResult({ ...review, sendInvoked: true, composerCleared: true }, handoff), false);
  assert.equal(validateAndroidNativeWakeResult({ ...review, reason: "private_editor_text" }, handoff), false);
  const { reason: _reviewReason, ...missingReviewReason } = review;
  assert.equal(validateAndroidNativeWakeResult(missingReviewReason, handoff), false);
});

test("ordinary command rows cannot smuggle a native wake handoff or arbitrary action", () => {
  const row = {
    id: commandId, device_id: deviceId, room_id: roomId, session_id: sessionId,
    request_id: requestId,
    command: { deviceId, roomId, sessionId, requestId, issuedAt: now,
      command: "request_control", appPackageName },
  };
  assert.equal(mapAndroidQueuedCommand({
    ...row, command: { ...row.command, action: "native_wake_trigger", nativeWakeHandoff: nativeHandoff() },
  }, { now }), null);
  assert.equal(mapAndroidQueuedCommand({
    ...row, command: { ...row.command, command: "send_text", text: "private data" },
  }, { now }), null);
});

test("native wake handoff accepts only the issuer clock skew window", () => {
  const valid = nativeHandoff();
  const withinClockSkew = { ...valid, issuedAt: now + 2_000, expiresAt: now + 22_000 };
  assert.ok(validateAndroidNativeWakeHandoff(withinClockSkew, { now }));
  const beyondClockSkew = { ...valid, issuedAt: now + 3_001, expiresAt: now + 23_001 };
  assert.equal(validateAndroidNativeWakeHandoff(beyondClockSkew, { now }), null);
});


test("native binding challenge is a fresh owner-scoped request for one Android screen and group binding", () => {
  const valid = {
    deviceId, roomId, requestId, issuedAt: now, sessionId, appPackageName,
    bindingId: "123e4567-e89b-42d3-a456-426614174005",
  };
  assert.equal(validateAndroidNativeBindingChallenge(valid, { now })?.bindingId, valid.bindingId);
  assert.equal(validateAndroidNativeBindingChallenge({ ...valid, issuedAt: now - 30_001 }, { now }), null);
  assert.equal(validateAndroidNativeBindingChallenge({ ...valid, appPackageName: "com..notes" }, { now }), null);
  assert.equal(validateAndroidNativeBindingChallenge({ ...valid, bindingId: "bad" }, { now }), null);
  assert.equal(validateAndroidNativeBindingChallenge({ ...valid, nonce: "a".repeat(64) }, { now }), null);
});

test("native binding completion accepts only device-local opaque digests and exact challenge scope", () => {
  const valid = {
    challengeId: requestId, nonce: "a".repeat(64), screenSessionId: sessionId,
    appPackageName, appSigningCertificateSha256: "b".repeat(64),
    composerIdentityDigest: "c".repeat(64), sendControlIdentityDigest: "d".repeat(64),
    providerConversationIdentityDigest: "e".repeat(64),
  };
  assert.equal(validateAndroidNativeBindingCompletion(valid)?.providerConversationIdentityDigest, valid.providerConversationIdentityDigest);
  const secondSigner = "f".repeat(64);
  const multiSigner = { ...valid, appSigningCertificateSha256: [valid.appSigningCertificateSha256, secondSigner].sort().join(".") };
  assert.equal(validateAndroidNativeBindingCompletion(multiSigner)?.appSigningCertificateSha256, multiSigner.appSigningCertificateSha256);
  assert.equal(validateAndroidNativeBindingCompletion({ ...multiSigner, appSigningCertificateSha256: multiSigner.appSigningCertificateSha256.replace(".", "/") }), null);
  assert.equal(validateAndroidNativeBindingCompletion({ ...valid, appSigningCertificateSha256: "bad" }), null);
  assert.equal(validateAndroidNativeBindingCompletion({ ...valid, providerConversationIdentityDigest: null }), null);
  assert.equal(validateAndroidNativeBindingCompletion({ ...valid, extra: true }), null);
  assert.equal(validateAndroidNativeBindingCompletion({ ...valid, nonce: "short" }), null);
});
