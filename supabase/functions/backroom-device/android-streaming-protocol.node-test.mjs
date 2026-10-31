import test from "node:test";
import assert from "node:assert/strict";
import {
  validateAndroidSessionStart, validateAndroidDeviceCommand,
  validateAndroidSignal, validateAndroidCommandAck
} from "./android-streaming-protocol.mjs";

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
  assert.ok(validateAndroidCommandAck(valid));\n  assert.equal(validateAndroidCommandAck({ ...valid, canControl: "yes" }), null);
  assert.equal(validateAndroidCommandAck({ ...valid, result: "x".repeat(81) }), null);
  assert.equal(validateAndroidCommandAck({ ...valid, sessionId: "bad" }), null);
  assert.equal(validateAndroidCommandAck({ ...valid, ignored: 1 }), null);
});
