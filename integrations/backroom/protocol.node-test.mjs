import test from "node:test";
import assert from "node:assert/strict";
import { BACKROOM_PROTOCOL, BACKROOM_PROTOCOL_VERSION, validateBackroomRegistration, validateBackroomCommand, validateBackroomResult } from "./protocol.mjs";

const now = Date.parse("2026-10-27T10:00:00.000Z");
const registration = (extra = {}) => ({
  protocol: BACKROOM_PROTOCOL, version: BACKROOM_PROTOCOL_VERSION, deviceId: "device-01", platform: "windows",
  groupId: "10000000-0000-4000-8000-000000000001", sessionId: "session-01", provider: "chatgpt",
  label: "Existing ChatGPT conversation", connectionMode: "attach_existing",
  capabilities: ["session.inspect", "conversation.read", "conversation.send", "browser.navigate", "terminal.execute"],
  consent: { granted: true, approvedBy: "human-01", approvedAt: "2026-10-27T09:55:00.000Z" }, ...extra,
});
const approval = (request, extra = {}) => ({
  approvalId: "approval-01", approvedBy: "human-01", requestId: request.requestId,
  idempotencyKey: request.idempotencyKey, action: request.action,
  groupId: request.groupId, sessionId: request.sessionId, params: request.params, requestedBy: request.requestedBy,
  approvedAt: "2026-10-27T09:59:00.000Z", expiresAt: "2026-10-27T10:01:00.000Z", ...extra,
});
const command = (action, params = {}, extra = {}) => ({
  protocol: BACKROOM_PROTOCOL, version: BACKROOM_PROTOCOL_VERSION, requestId: "request-01", idempotencyKey: "idem-01",
  groupId: "10000000-0000-4000-8000-000000000001", sessionId: "session-01", action, params,
  requestedBy: { kind: "human", id: "human-01" }, ...extra,
});
const valid = (request, session = registration(), options = {}) => validateBackroomCommand(request, session, { now, ...options });
const has = (result, pattern) => assert.match(result.errors.join(" "), pattern);

test("accepts both Windows attach and Android managed registrations", () => {
  assert.equal(validateBackroomRegistration(registration()).valid, true);
  assert.equal(validateBackroomRegistration(registration({ platform: "android", connectionMode: "managed", deviceId: "android-01" })).valid, true);
});

test("rejects missing consent, unsupported platforms and malformed group IDs or timestamps", () => {
  has(validateBackroomRegistration(registration({ consent: { granted: false } })), /explicit user consent/);
  has(validateBackroomRegistration(registration({ platform: "ios" })), /unsupported platform/);
  has(validateBackroomRegistration(registration({ groupId: "room-1" })), /groupId must be a UUID/);
  has(validateBackroomRegistration(registration({ consent: { granted: true, approvedBy: "human-01", approvedAt: "2026-02-30T09:55:00.000Z" } })), /ISO timestamp/);
});

test("rejects unsupported versions/capabilities, duplicate capabilities and extra registration fields", () => {
  has(validateBackroomRegistration(registration({ version: 2 })), /protocol version/);
  has(validateBackroomRegistration(registration({ capabilities: ["root.shell"] })), /unsupported capability/);
  has(validateBackroomRegistration(registration({ capabilities: ["conversation.read", "conversation.read"] })), /duplicates/);
  has(validateBackroomRegistration(registration({ accessToken: "must-not-be-sent" })), /unsupported field/);
});

test("permits a read command only for the registered group/session and granted capability", () => {
  assert.equal(valid(command("conversation.read")).valid, true);
  has(valid(command("conversation.read", {}, { groupId: "20000000-0000-4000-8000-000000000002" })), /groupId does not match/);
  has(valid(command("conversation.read", {}, { sessionId: "another-session" })), /sessionId does not match/);
  has(valid(command("conversation.read"), registration({ capabilities: ["session.inspect"] })), /has not granted capability/);
});

test("requires exact, current approvals for sensitive actions and keeps terminal execution disabled", () => {
  const send = command("conversation.send", { text: "Hello group" });
  has(valid(send), /requires a trusted approval/);
  assert.equal(valid(send, registration(), { trustedApproval: approval(send) }).valid, true);
  has(valid(send, registration(), { trustedApproval: approval(send, { action: "terminal.execute" }) }), /approval action does not match/);
  has(valid(send, registration(), { trustedApproval: approval(send, { params: { text: "changed after approval" } }) }), /approved params do not match/);
  has(valid(send, registration(), { trustedApproval: approval(send, { idempotencyKey: "different-idempotency-key" }) }), /approval idempotencyKey does not match/);
  has(valid(send, registration(), { trustedApproval: approval(send, { requestedBy: { kind: "ai", id: "different-agent" } }) }), /approval requester does not match/);
  has(valid(send, registration(), { trustedApproval: approval(send, { groupId: "20000000-0000-4000-8000-000000000002" }) }), /approval groupId does not match/);
  has(valid(send, registration(), { trustedApproval: approval(send, { expiresAt: "2026-10-27T09:59:59.000Z" }) }), /expired/);
  const terminal = command("terminal.execute", { command: "npm test" });
  has(valid(terminal, registration(), { trustedApproval: approval(terminal) }), /reserved until a sandboxed platform adapter/);
});

test("rejects approvals supplied by untrusted command payloads", () => {
  const send = command("conversation.send", { text: "Post this" }, { approval: approval(command("conversation.send", { text: "Post this" })) });
  has(valid(send), /unsupported field: approval/);
});

test("allows safe HTTPS navigation only when approval is trusted", () => {
  const good = command("browser.navigate", { url: "https://chatgpt.com/" });
  assert.equal(valid(good, registration(), { trustedApproval: approval(good) }).valid, true);
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "https://user:pass@example.com", "not-a-url"]) {
    const bad = command("browser.navigate", { url });
    assert.equal(valid(bad, registration(), { trustedApproval: approval(bad) }).valid, false, url);
  }
});

test("rejects empty/oversized text and unrecognized action parameters", () => {
  const empty = command("conversation.send", { text: " " });
  const huge = command("conversation.send", { text: "x".repeat(10001) });
  assert.equal(valid(empty, registration(), { trustedApproval: approval(empty) }).valid, false);
  assert.equal(valid(huge, registration(), { trustedApproval: approval(huge) }).valid, false);
  assert.equal(valid(command("conversation.read", { includePrivateHistory: true })).valid, false);
  assert.equal(valid(command("unknown.action")).valid, false);
  assert.equal(valid(command("__proto__")).valid, false);
  assert.equal(valid(command("constructor")).valid, false);
});

test("rejects unexpected command fields and malformed caller identity", () => {
  assert.equal(valid(command("conversation.read", {}, { authorization: "bearer secret" })).valid, false);
  assert.equal(valid(command("conversation.read", {}, { requestedBy: { kind: "ai", id: "agent-01", token: "secret" } })).valid, false);
});

test("validates results and prevents cross-request result confusion", () => {
  const request = command("conversation.read");
  const response = { protocol: BACKROOM_PROTOCOL, version: BACKROOM_PROTOCOL_VERSION, requestId: request.requestId,
    groupId: request.groupId, sessionId: request.sessionId, status: "succeeded", completedAt: "2026-10-27T10:00:00.000Z", output: { messages: [] } };
  assert.equal(validateBackroomResult(response, request).valid, true);
  has(validateBackroomResult({ ...response, sessionId: "other-session" }, request), /does not match/);
  has(validateBackroomResult({ ...response, status: "failed" }, request), /must include an error/);
});

test("rejects malformed validator options instead of throwing", () => {
  const request = command("conversation.read");
  assert.equal(validateBackroomCommand(request, registration(), null).valid, false);
  assert.equal(validateBackroomCommand(request, registration(), { now: NaN }).valid, false);
  assert.equal(validateBackroomCommand(request, registration(), { now, unexpected: true }).valid, false);
});
