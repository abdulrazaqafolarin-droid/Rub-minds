const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)+$/;
const MAX_SDP_CHARS = 65_536;
const MAX_REQUEST_AGE_MS = 30_000;

const isUuid = value => typeof value === "string" && UUID.test(value);
const exactKeys = (value, allowed, required = allowed) =>
  !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).every(key => allowed.includes(key)) &&
  required.every(key => Object.hasOwn(value, key));

function validSdp(sdp) {
  return typeof sdp === "string" && sdp.length >= 8 &&
    sdp.length <= MAX_SDP_CHARS && sdp.startsWith("v=0");
}

export function validateAndroidSessionStart(value, { now = Date.now() } = {}) {
  const keys = ["deviceId", "roomId", "requestId", "issuedAt", "sessionId", "appPackageName", "offer"];
  if (!exactKeys(value, keys) || !isUuid(value.deviceId) || !isUuid(value.roomId) ||
      !isUuid(value.requestId) || !isUuid(value.sessionId) ||
      !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(now) ||
      Math.abs(now - value.issuedAt) > MAX_REQUEST_AGE_MS ||
      typeof value.appPackageName !== "string" || !PACKAGE.test(value.appPackageName) ||
      !exactKeys(value.offer, ["sdp"]) || !validSdp(value.offer.sdp)) return null;
  return Object.freeze({ ...value, offer: Object.freeze({ ...value.offer }) });
}

export function validateAndroidDeviceCommand(value, { now = Date.now() } = {}) {
  const keys = ["deviceId", "roomId", "requestId", "issuedAt", "sessionId", "command", "appPackageName"];
  if (!exactKeys(value, keys) || !isUuid(value.deviceId) || !isUuid(value.roomId) ||
      !isUuid(value.requestId) || !isUuid(value.sessionId) ||
      !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(now) ||
      Math.abs(now - value.issuedAt) > MAX_REQUEST_AGE_MS ||
      !["request_control", "stop_session"].includes(value.command) ||
      typeof value.appPackageName !== "string" || !PACKAGE.test(value.appPackageName)) return null;
  return Object.freeze({ ...value });
}

export function validateAndroidSignal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !isUuid(value.sessionId) || !exactKeys(value, ["sessionId", "answer", "canControl"], ["sessionId", "answer", "canControl"]) ||
      !exactKeys(value.answer, ["type", "sdp"]) || value.answer.type !== "answer" ||
      !validSdp(value.answer.sdp) || typeof value.canControl !== "boolean") return null;
  return Object.freeze({ ...value, answer: Object.freeze({ ...value.answer }) });
}

export function validateAndroidCommandAck(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !exactKeys(value, ["commandId", "requestId", "sessionId", "result", "canControl"], ["commandId", "requestId", "sessionId", "result"]) ||
      !isUuid(value.commandId) || !isUuid(value.requestId) || !isUuid(value.sessionId) ||
      typeof value.result !== "string" || value.result.length < 1 || value.result.length > 80 ||
      (value.canControl !== undefined && typeof value.canControl !== "boolean")) return null;
  return Object.freeze({ ...value });
}

export function validateAndroidSessionClose(value) {
  if (!exactKeys(value, ["roomId", "sessionId"]) || !isUuid(value.roomId) || !isUuid(value.sessionId)) return null;
  return Object.freeze({ roomId: value.roomId, sessionId: value.sessionId });
}

export function mapAndroidQueuedCommand(row) {
  if (!row || typeof row !== "object" || Array.isArray(row) ||
      !isUuid(row.id) || !isUuid(row.request_id) || !isUuid(row.session_id) ||
      !isUuid(row.device_id) || !isUuid(row.room_id) ||
      !row.command || typeof row.command !== "object" || Array.isArray(row.command)) return null;
  const command = row.command;
  const action = command.action ?? command.command;
  if (!["view_offer", "request_control", "stop_session"].includes(action) ||
      command.deviceId !== row.device_id || command.roomId !== row.room_id ||
      command.sessionId !== row.session_id || !isUuid(command.requestId) ||
      command.requestId !== row.request_id || typeof command.appPackageName !== "string" ||
      !PACKAGE.test(command.appPackageName)) return null;
  if (action === "view_offer" && (!exactKeys(command.offer, ["sdp"]) || !validSdp(command.offer.sdp))) return null;
  return Object.freeze({
    ...command,
    action,
    commandId: row.id,
    requestId: row.request_id,
    sessionId: row.session_id,
  });
}
