/** Shared Windows/Android Backroom protocol. Validation only: no device authentication or execution. */
export const BACKROOM_PROTOCOL = "rub-minds.backroom";
export const BACKROOM_PROTOCOL_VERSION = 1;
export const BACKROOM_PLATFORMS = Object.freeze(["windows", "android"]);
export const BACKROOM_CONNECTION_MODES = Object.freeze(["attach_existing", "managed"]);
export const BACKROOM_CAPABILITIES = Object.freeze([
  "session.inspect", "conversation.read", "conversation.send", "browser.navigate",
  "screenshot.capture", "terminal.execute", "task.cancel",
]);

const POLICIES = Object.freeze({
  "session.inspect": { capability: "session.inspect", approval: false, params: [] },
  "conversation.read": { capability: "conversation.read", approval: false, params: [] },
  "conversation.send": { capability: "conversation.send", approval: true, params: ["text"] },
  "browser.navigate": { capability: "browser.navigate", approval: true, params: ["url"] },
  "screenshot.capture": { capability: "screenshot.capture", approval: true, params: ["purpose"] },
  "terminal.execute": { capability: "terminal.execute", approval: true, params: ["command"] },
  "task.cancel": { capability: "task.cancel", approval: false, params: [] },
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/;
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const nonempty = (value, limit = 128) => typeof value === "string" && value.trim().length > 0 && value.length <= limit;
function timestamp(value) {
  if (typeof value !== "string") return false;
  const match = ISO_DATE.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const wall = new Date(0);
  wall.setUTCFullYear(year, month - 1, day);
  wall.setUTCHours(hour, minute, second, 0);
  if (wall.getUTCFullYear() !== year || wall.getUTCMonth() !== month - 1 || wall.getUTCDate() !== day ||
      wall.getUTCHours() !== hour || wall.getUTCMinutes() !== minute || wall.getUTCSeconds() !== second) return false;
  if (match[8] !== undefined && (Number(match[8]) > 23 || Number(match[9]) > 59)) return false;
  return true;
}
function canonicalJson(value, depth = 0) {
  if (depth > 32) throw new TypeError("Maximum JSON nesting exceeded");
  if (Array.isArray(value)) return "[" + value.map(item => canonicalJson(item, depth + 1)).join(",") + "]";
  if (record(value)) return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonicalJson(value[key], depth + 1)).join(",") + "}";
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Only JSON-compatible values are supported");
  return encoded;
}
const report = errors => Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });

function required(errors, value, field, limit = 128) {
  if (!nonempty(value, limit)) errors.push(field + " must be a non-empty string of at most " + limit + " characters");
}
function onlyKeys(value, keys, errors, label) {
  for (const key of Object.keys(value)) if (!keys.includes(key)) errors.push(label + " contains unsupported field: " + key);
}

export function validateBackroomRegistration(input) {
  const errors = [];
  if (!record(input)) return report(["registration must be an object"]);
  if (input.protocol !== BACKROOM_PROTOCOL) errors.push("unsupported protocol");
  if (input.version !== BACKROOM_PROTOCOL_VERSION) errors.push("unsupported protocol version");
  required(errors, input.deviceId, "deviceId");
  required(errors, input.sessionId, "sessionId");
  if (typeof input.groupId !== "string" || !UUID.test(input.groupId)) errors.push("groupId must be a UUID");
  if (!BACKROOM_PLATFORMS.includes(input.platform)) errors.push("unsupported platform");
  if (!BACKROOM_CONNECTION_MODES.includes(input.connectionMode)) errors.push("unsupported connection mode");
  required(errors, input.provider, "provider", 64);
  required(errors, input.label, "label", 120);
  if (!Array.isArray(input.capabilities)) errors.push("capabilities must be an array");
  else {
    if (new Set(input.capabilities).size !== input.capabilities.length) errors.push("capabilities must not contain duplicates");
    for (const name of input.capabilities) if (!BACKROOM_CAPABILITIES.includes(name)) errors.push("unsupported capability: " + String(name));
  }
  if (!record(input.consent)) errors.push("consent record is required");
  else {
    if (input.consent.granted !== true) errors.push("explicit user consent is required");
    required(errors, input.consent.approvedBy, "consent.approvedBy");
    if (!timestamp(input.consent.approvedAt)) errors.push("consent.approvedAt must be an ISO timestamp");
    onlyKeys(input.consent, ["granted", "approvedBy", "approvedAt"], errors, "consent");
  }
  onlyKeys(input, ["protocol", "version", "deviceId", "platform", "groupId", "sessionId", "provider", "label", "connectionMode", "capabilities", "consent"], errors, "registration");
  return report(errors);
}

function checkApproval(approval, command, now, errors) {
  if (!record(approval)) { errors.push("this action requires a trusted approval record"); return; }
  required(errors, approval.approvalId, "approval.approvalId", 200);
  required(errors, approval.approvedBy, "approval.approvedBy");
  if (approval.requestId !== command.requestId) errors.push("approval requestId does not match command");
  if (approval.idempotencyKey !== command.idempotencyKey) errors.push("approval idempotencyKey does not match command");
  if (approval.action !== command.action) errors.push("approval action does not match command");
  if (approval.groupId !== command.groupId) errors.push("approval groupId does not match command");
  if (approval.sessionId !== command.sessionId) errors.push("approval sessionId does not match command");
  let paramsMatch = false, requesterMatches = false;
  try {
    paramsMatch = record(approval.params) && record(command.params) && canonicalJson(approval.params) === canonicalJson(command.params);
    requesterMatches = record(approval.requestedBy) && record(command.requestedBy) && canonicalJson(approval.requestedBy) === canonicalJson(command.requestedBy);
  } catch { paramsMatch = false; requesterMatches = false; }
  if (!paramsMatch) errors.push("approved params do not match command");
  if (!requesterMatches) errors.push("approval requester does not match command");
  if (!timestamp(approval.approvedAt)) errors.push("approval.approvedAt must be an ISO timestamp");
  if (!timestamp(approval.expiresAt)) errors.push("approval.expiresAt must be an ISO timestamp");
  if (timestamp(approval.approvedAt) && timestamp(approval.expiresAt)) {
    const granted = Date.parse(approval.approvedAt), expires = Date.parse(approval.expiresAt);
    if (expires <= granted) errors.push("approval must expire after it was granted");
    if (granted > now) errors.push("approval cannot be from the future");
    if (expires <= now) errors.push("approval has expired");
  }
  onlyKeys(approval, ["approvalId", "approvedBy", "requestId", "idempotencyKey", "action", "groupId", "sessionId", "params", "requestedBy", "approvedAt", "expiresAt"], errors, "approval");
}

function checkParams(action, params, errors) {
  if (!record(params)) { errors.push("params must be an object"); return; }
  onlyKeys(params, POLICIES[action].params, errors, "params");
  if (action === "conversation.send" && !nonempty(params.text, 10000)) errors.push("params.text must contain 1-10000 characters");
  if (action === "terminal.execute" && !nonempty(params.command, 2000)) errors.push("params.command must contain 1-2000 characters");
  if (action === "screenshot.capture" && params.purpose !== undefined && !nonempty(params.purpose, 240)) errors.push("params.purpose must be a non-empty string of at most 240 characters when provided");
  if (action === "browser.navigate") {
    if (!nonempty(params.url, 2048)) errors.push("params.url must be a non-empty URL of at most 2048 characters");
    else try {
      const url = new URL(params.url);
      if (url.protocol !== "https:" || url.username || url.password) errors.push("navigation requires an HTTPS URL without embedded credentials");
    } catch { errors.push("params.url must be an absolute URL"); }
  }
}

/** trustedApproval must come from the local host approval store, never command input. */
export function validateBackroomCommand(input, registration, { now = Date.now(), trustedApproval = null } = {}) {
  const errors = [];
  if (!Number.isFinite(now)) return report(["now must be a finite timestamp"]);
  if (!record(input)) return report(["command must be an object"]);
  const registered = validateBackroomRegistration(registration);
  if (!registered.valid) errors.push("registration is invalid");
  if (input.protocol !== BACKROOM_PROTOCOL) errors.push("unsupported protocol");
  if (input.version !== BACKROOM_PROTOCOL_VERSION) errors.push("unsupported protocol version");
  required(errors, input.requestId, "requestId", 200);
  required(errors, input.idempotencyKey, "idempotencyKey", 200);
  if (input.groupId !== registration?.groupId) errors.push("groupId does not match registered session");
  if (input.sessionId !== registration?.sessionId) errors.push("sessionId does not match registered session");
  if (!record(input.requestedBy) || !["human", "ai", "system"].includes(input.requestedBy.kind) || !nonempty(input.requestedBy.id)) errors.push("requestedBy must contain a supported kind and non-empty id");
  else onlyKeys(input.requestedBy, ["kind", "id"], errors, "requestedBy");
  const policy = Object.hasOwn(POLICIES, input.action) ? POLICIES[input.action] : null;
  if (!policy) errors.push("unsupported action");
  else {
    if (!registered.valid || !registration.capabilities.includes(policy.capability)) errors.push("session has not granted capability " + policy.capability);
    checkParams(input.action, input.params, errors);
    if (policy.approval) checkApproval(trustedApproval, input, now, errors);
  }
  onlyKeys(input, ["protocol", "version", "requestId", "idempotencyKey", "groupId", "sessionId", "action", "params", "requestedBy"], errors, "command");
  return report(errors);
}

export function validateBackroomResult(input, request) {
  const errors = [];
  if (!record(input)) return report(["result must be an object"]);
  if (!record(request)) return report(["request must be an object"]);
  if (input.protocol !== BACKROOM_PROTOCOL) errors.push("unsupported protocol");
  if (input.version !== BACKROOM_PROTOCOL_VERSION) errors.push("unsupported protocol version");
  if (input.requestId !== request.requestId) errors.push("result requestId does not match command");
  if (input.groupId !== request.groupId) errors.push("result groupId does not match command");
  if (input.sessionId !== request.sessionId) errors.push("result sessionId does not match command");
  if (!["succeeded", "rejected", "failed", "cancelled", "waiting_for_approval"].includes(input.status)) errors.push("unsupported result status");
  if (!timestamp(input.completedAt)) errors.push("completedAt must be an ISO timestamp");
  if (input.output !== undefined && !record(input.output)) errors.push("output must be an object when provided");
  if (input.error !== undefined && !nonempty(input.error, 1000)) errors.push("error must contain 1-1000 characters when provided");
  if (input.status === "failed" && !nonempty(input.error, 1000)) errors.push("failed results must include an error");
  onlyKeys(input, ["protocol", "version", "requestId", "groupId", "sessionId", "status", "completedAt", "output", "error"], errors, "result");
  return report(errors);
}