import { createHash } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX = /^[a-f0-9]{64}$/;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const MAX_SDP_CHARS = 65_536;
const MAX_REQUEST_AGE_MS = 30_000;
const MAX_NATIVE_HANDOFF_TTL_MS = 20_000;
const ANDROID_NATIVE_SURFACE = "android_app";
const NATIVE_RESULT_STATES = new Set(["preflight_denied", "submitted", "needs_review"]);

function exactKeys(value, keys) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}

function isPackageName(value) {
  return typeof value === "string" && value.length <= 255 && PACKAGE.test(value);
}

function isNonempty(value, max = 512) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalWakePrompt(eventId) {
  return EVENT_ID.test(eventId)
    ? `@RMconnects\nEvent: ${eventId}\nRetrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer according to your group policy. Acknowledge via MCP.`
    : null;
}

function validSdp(sdp) {
  return typeof sdp === "string" && sdp.length >= 8 &&
    sdp.length <= MAX_SDP_CHARS && sdp.startsWith("v=0");
}

export function validateAndroidSessionStart(value, { now = Date.now() } = {}) {
  const keys = ["deviceId", "roomId", "requestId", "issuedAt", "sessionId", "appPackageName", "offer"];
  if (!exactKeys(value, keys) || !UUID.test(value.deviceId ?? "") || !UUID.test(value.roomId ?? "") ||
      !UUID.test(value.requestId ?? "") || !UUID.test(value.sessionId ?? "") ||
      !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(now) ||
      Math.abs(now - value.issuedAt) > MAX_REQUEST_AGE_MS ||
      !isPackageName(value.appPackageName) || !exactKeys(value.offer, ["sdp"]) || !validSdp(value.offer.sdp)) return null;
  return Object.freeze({ ...value, offer: Object.freeze({ ...value.offer }) });
}

export function validateAndroidDeviceCommand(value, { now = Date.now() } = {}) {
  const keys = ["deviceId", "roomId", "requestId", "issuedAt", "sessionId", "command", "appPackageName"];
  if (!exactKeys(value, keys) || !UUID.test(value.deviceId ?? "") || !UUID.test(value.roomId ?? "") ||
      !UUID.test(value.requestId ?? "") || !UUID.test(value.sessionId ?? "") ||
      !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(now) ||
      Math.abs(now - value.issuedAt) > MAX_REQUEST_AGE_MS ||
      !["request_control", "stop_session"].includes(value.command) ||
      !isPackageName(value.appPackageName)) return null;
  return Object.freeze({ ...value });
}

export function validateAndroidNativeWakeHandoff(value, { now = Date.now(), clockSkewMs = 3_000 } = {}) {
  const keys = [
    "version", "kind", "handoffId", "jobId", "eventId", "deviceId", "roomId", "screenSessionId",
    "hostId", "bindingId", "sessionId", "targetId", "targetRevision", "surface", "appId",
    "identityFingerprint", "composerIdentityDigest", "sendControlIdentityDigest",
    "leaseTokenDigest", "prompt", "promptDigest", "issuedAt", "leaseExpiresAt", "expiresAt",
  ];
  const expectedPrompt = value && typeof value === "object" ? canonicalWakePrompt(value.eventId) : null;
  if (!exactKeys(value, keys) ||
      value.version !== 1 || value.kind !== "native_wake_trigger" ||
      !UUID.test(value.handoffId ?? "") || !UUID.test(value.jobId ?? "") ||
      !EVENT_ID.test(value.eventId ?? "") ||
      !UUID.test(value.deviceId ?? "") || !UUID.test(value.roomId ?? "") ||
      !UUID.test(value.screenSessionId ?? "") || !UUID.test(value.hostId ?? "") ||
      !UUID.test(value.bindingId ?? "") || !isNonempty(value.sessionId, 256) ||
      !isNonempty(value.targetId, 128) ||
      !Number.isSafeInteger(value.targetRevision) || value.targetRevision < 1 ||
      value.surface !== ANDROID_NATIVE_SURFACE || !isPackageName(value.appId) ||
      !isNonempty(value.identityFingerprint) ||
      !HEX.test(value.composerIdentityDigest ?? "") ||
      !HEX.test(value.sendControlIdentityDigest ?? "") ||
      !HEX.test(value.leaseTokenDigest ?? "") ||
      value.prompt !== expectedPrompt || !HEX.test(value.promptDigest ?? "") ||
      sha256(value.prompt) !== value.promptDigest ||
      !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.leaseExpiresAt) ||
      !Number.isSafeInteger(value.expiresAt) || !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(clockSkewMs) || clockSkewMs < 0 || clockSkewMs > 10_000 ||
      value.issuedAt > now + clockSkewMs || value.expiresAt <= now ||
      value.leaseExpiresAt <= now || value.expiresAt > value.leaseExpiresAt ||
      value.expiresAt - value.issuedAt > MAX_NATIVE_HANDOFF_TTL_MS ||
      value.issuedAt >= value.leaseExpiresAt) return null;
  return Object.freeze({ ...value });
}

export function validateAndroidSignal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !UUID.test(value.sessionId ?? "") || !exactKeys(value, ["sessionId", "answer", "canControl"]) ||
      !exactKeys(value.answer, ["type", "sdp"]) || value.answer.type !== "answer" ||
      !validSdp(value.answer.sdp) || typeof value.canControl !== "boolean") return null;
  return Object.freeze({ ...value, answer: Object.freeze({ ...value.answer }) });
}

export function validateAndroidNativeWakeResult(result, handoff) {
  const required = [
    "version", "kind", "handoffId", "jobId", "deviceId", "roomId", "screenSessionId",
    "bindingId", "targetId", "targetRevision", "state", "promptInserted", "sendInvoked", "composerCleared",
  ];
  const verificationEvidence = [
    "promptReadbackVerified", "composerIdentityRevalidated", "sendControlIdentityRevalidated",
    "composerIdentityDigest", "sendControlIdentityDigest",
  ];
  const optional = [...verificationEvidence, "reason"];
  const reasons = new Set([
    "foreground_changed", "composer_not_empty", "composer_identity_changed",
    "send_control_unavailable", "send_identity_changed", "permission_denied",
    "device_disconnected", "send_unconfirmed", "outcome_unknown", "other",
  ]);
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      Object.keys(result).some(key => ![...required, ...optional].includes(key)) ||
      !required.every(key => Object.hasOwn(result, key)) ||
      result.version !== 1 || result.kind !== "native_wake_result" ||
      result.handoffId !== handoff?.handoffId || result.jobId !== handoff?.jobId ||
      result.deviceId !== handoff?.deviceId || result.roomId !== handoff?.roomId ||
      result.screenSessionId !== handoff?.screenSessionId || result.bindingId !== handoff?.bindingId ||
      result.targetId !== handoff?.targetId || result.targetRevision !== handoff?.targetRevision ||
      !NATIVE_RESULT_STATES.has(result.state) ||
      typeof result.promptInserted !== "boolean" || typeof result.sendInvoked !== "boolean" ||
      typeof result.composerCleared !== "boolean" ||
      (result.reason !== undefined && !reasons.has(result.reason))) return false;

  if (result.state === "preflight_denied") {
    return result.reason !== undefined &&
      result.promptInserted === false && result.sendInvoked === false &&
      result.composerCleared === false &&
      verificationEvidence.every(key => result[key] === undefined);
  }
  if (result.state === "submitted") {
    return result.reason === undefined &&
      result.promptInserted === true && result.sendInvoked === true &&
      result.composerCleared === true && result.promptReadbackVerified === true &&
      result.composerIdentityRevalidated === true && result.sendControlIdentityRevalidated === true &&
      result.composerIdentityDigest === handoff?.composerIdentityDigest &&
      result.sendControlIdentityDigest === handoff?.sendControlIdentityDigest &&
      HEX.test(result.composerIdentityDigest ?? "") && HEX.test(result.sendControlIdentityDigest ?? "");
  }
  // An ambiguous post-seal result is terminal review, never a safe retry.
  // It may not claim the stronger successful read-back/revalidation evidence.
  return result.reason !== undefined && result.composerCleared === false &&
    verificationEvidence.every(key => result[key] === undefined);
}

export function validateAndroidCommandAck(value) {
  const allowed = ["commandId", "requestId", "sessionId", "result", "canControl", "nativeWakeResult"];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !Object.keys(value).every(key => allowed.includes(key)) ||
      !["commandId", "requestId", "sessionId", "result"].every(key => Object.hasOwn(value, key)) ||
      !UUID.test(value.commandId ?? "") || !UUID.test(value.requestId ?? "") ||
      !UUID.test(value.sessionId ?? "") ||
      typeof value.result !== "string" || value.result.length < 1 || value.result.length > 80 ||
      (value.canControl !== undefined && typeof value.canControl !== "boolean") ||
      (value.nativeWakeResult !== undefined &&
        (!value.nativeWakeResult || typeof value.nativeWakeResult !== "object" || Array.isArray(value.nativeWakeResult)))) return null;
  return Object.freeze({ ...value });
}

export function validateAndroidSessionClose(value) {
  if (!exactKeys(value, ["roomId", "sessionId"]) || !UUID.test(value.roomId ?? "") || !UUID.test(value.sessionId ?? "")) return null;
  return Object.freeze({ roomId: value.roomId, sessionId: value.sessionId });
}

export function mapAndroidQueuedCommand(row, { now = Date.now() } = {}) {
  if (!row || typeof row !== "object" || Array.isArray(row) ||
      !UUID.test(row.id ?? "") || !UUID.test(row.request_id ?? "") || !UUID.test(row.session_id ?? "") ||
      !UUID.test(row.device_id ?? "") || !UUID.test(row.room_id ?? "") ||
      !row.command || typeof row.command !== "object" || Array.isArray(row.command)) return null;
  const command = row.command;
  const action = command.action ?? command.command;
  if (command.deviceId !== row.device_id || command.roomId !== row.room_id ||
      !UUID.test(command.requestId ?? "") || command.requestId !== row.request_id) return null;

  if (action === "native_wake_trigger") {
    const outerKeys = [
      "action", "deviceId", "roomId", "requestId", "issuedAt", "sessionId",
      "appPackageName", "nativeWakeHandoff",
    ];
    const handoff = validateAndroidNativeWakeHandoff(command.nativeWakeHandoff, { now });
    if (!exactKeys(command, outerKeys) || !handoff ||
        command.sessionId !== row.session_id || handoff.deviceId !== row.device_id ||
        handoff.roomId !== row.room_id || handoff.screenSessionId !== row.session_id ||
        command.sessionId !== handoff.screenSessionId || command.issuedAt !== handoff.issuedAt ||
        command.appPackageName !== handoff.appId) return null;
    return Object.freeze({
      ...command, action, commandId: row.id, requestId: row.request_id,
      sessionId: row.session_id, nativeWakeHandoff: handoff,
    });
  }

  if (!["view_offer", "request_control", "stop_session"].includes(action) ||
      !isPackageName(command.appPackageName)) return null;
  if (action === "view_offer" && (!exactKeys(command.offer, ["sdp"]) || !validSdp(command.offer.sdp))) return null;
  return Object.freeze({
    ...command,
    action,
    commandId: row.id,
    requestId: row.request_id,
    sessionId: row.session_id,
  });
}
