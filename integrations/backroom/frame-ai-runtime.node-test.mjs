import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyFrameAiSession,
  FRAME_AI_RUNTIME_STATES,
} from "./frame-ai-runtime.mjs";

const NOW = Date.parse("2026-11-08T10:00:00.000Z");
const FUTURE = "2026-11-08T10:30:00.000Z";
const ROOM = "room-a";
const PARTICIPANT = "ai-participant-a";
const MCP_SESSION = "mcp-session-a";
const DEVICE = "device-a";
const RUNTIME_SESSION = "runtime-session-a";
const APP = "com.anthropic.claude";
const FINGERPRINT = "a".repeat(64);
const PROVIDER_DIGEST = "b".repeat(64);

function base(surface = "android_app") {
  return {
    roomId: ROOM,
    surface,
    participant: {
      participantId: PARTICIPANT, roomId: ROOM, kind: "original_session", status: "active",
    },
    mcpSession: {
      sessionId: MCP_SESSION, participantId: PARTICIPANT, roomId: ROOM,
      status: "active", expiresAt: FUTURE, terminatedAt: null,
    },
    device: { deviceId: DEVICE, roomId: ROOM, status: "active", approved: true },
    runtime: {
      sessionId: RUNTIME_SESSION, deviceId: DEVICE, roomId: ROOM, surface,
      appId: surface === "terminal" ? "opencode" : APP,
      identityFingerprint: FINGERPRINT,
      providerConversationIdentityVerified: surface !== "terminal",
      processIdentityVerified: surface === "terminal",
    },
    binding: {
      roomId: ROOM, participantId: PARTICIPANT, mcpSessionId: MCP_SESSION,
      deviceId: DEVICE, runtimeSessionId: RUNTIME_SESSION, surface,
      appId: surface === "terminal" ? "opencode" : APP,
      identityFingerprint: FINGERPRINT,
      processIdentityFingerprint: surface === "terminal" ? FINGERPRINT : undefined,
      providerConversationIdentityDigest: surface === "terminal" ? null : PROVIDER_DIGEST,
      expiresAt: FUTURE, revokedAt: null, wakeEnabled: false, wakeExpiresAt: null,
    },
    wakeConsent: null,
  };
}

test("AI group membership comes from an active MCP session, not device or app inventory", () => {
  const input = base();
  input.participant = null;
  const result = classifyFrameAiSession(input, { now: NOW });
  assert.equal(result.state, "ai_not_joined");
  assert.equal(result.canUseGroupTools, false);

  const deviceOnly = base();
  deviceOnly.mcpSession = null;
  assert.equal(classifyFrameAiSession(deviceOnly, { now: NOW }).state, "ai_not_joined");
});

test("a joined AI remains a group participant before any device frame is attached", () => {
  const input = base();
  input.device = null;
  const result = classifyFrameAiSession(input, { now: NOW });
  assert.equal(result.state, "device_unavailable");
  assert.equal(result.canUseGroupTools, true);
  assert.equal(result.canReceiveGroupEventsWhileActive, true);
  assert.equal(result.canRunInFrame, false);
});

test("an approved device and selected app do not attach an AI without an exact frame binding", () => {
  const input = base();
  input.binding = null;
  const result = classifyFrameAiSession(input, { now: NOW });
  assert.equal(result.state, "ai_joined_unbound");
  assert.equal(result.canUseGroupTools, true);
  assert.equal(result.canRunInFrame, false);
});

test("Android and desktop apps remain draft-only until provider conversation identity is attested", () => {
  for (const surface of ["android_app", "desktop_app", "windows_app"]) {
    const input = base(surface);
    input.runtime.providerConversationIdentityVerified = false;
    input.binding.providerConversationIdentityDigest = null;
    const result = classifyFrameAiSession(input, { now: NOW });
    assert.equal(result.state, "bound_draft_only", surface);
    assert.equal(result.canRunInFrame, true);
    assert.equal(result.canDraftToFrame, true);
    assert.equal(result.canAutoWakeFrame, false);
  }
});

test("native app wake requires both exact provider identity and separate unexpired device/group consent", () => {
  const input = base("android_app");
  input.binding.wakeEnabled = true;
  input.binding.wakeExpiresAt = FUTURE;
  input.wakeConsent = {
    granted: true, deviceId: DEVICE, runtimeSessionId: RUNTIME_SESSION,
    participantId: PARTICIPANT, expiresAt: FUTURE,
  };
  const ready = classifyFrameAiSession(input, { now: NOW });
  assert.equal(ready.state, "native_wake_ready");
  assert.equal(ready.canAutoWakeFrame, true);
  assert.equal(ready.requiresBrowserHost, false);

  input.wakeConsent.granted = false;
  const noLocalConsent = classifyFrameAiSession(input, { now: NOW });
  assert.equal(noLocalConsent.state, "bound_manual_only");
  assert.equal(noLocalConsent.canAutoWakeFrame, false);
});

test("terminal AI connects as the joined MCP participant and does not use native composer wake", () => {
  const input = base("terminal");
  const result = classifyFrameAiSession(input, { now: NOW });
  assert.equal(result.state, "terminal_connected");
  assert.equal(result.canUseGroupTools, true);
  assert.equal(result.canRunInFrame, true);
  assert.equal(result.canReceiveGroupEventsWhileActive, true);
  assert.equal(result.canAutoWakeFrame, false);
  assert.equal(result.requiresBrowserHost, false);
});

test("terminal process identity must be verified before the frame reports an attached AI", () => {
  const input = base("terminal");
  input.runtime.processIdentityVerified = false;
  const result = classifyFrameAiSession(input, { now: NOW });
  assert.equal(result.state, "bound_draft_only");
  assert.equal(result.canRunInFrame, true);
  assert.equal(result.canAutoWakeFrame, false);
});

test("room, participant, MCP session, device, frame session, app, surface and binary identity mismatches fail closed", () => {
  const mutations = [
    x => { x.mcpSession.roomId = "other-room"; },
    x => { x.mcpSession.participantId = "other-ai"; },
    x => { x.binding.participantId = "other-ai"; },
    x => { x.binding.mcpSessionId = "other-mcp-session"; },
    x => { x.device.deviceId = "other-device"; },
    x => { x.binding.runtimeSessionId = "other-runtime"; },
    x => { x.binding.appId = "com.other.app"; },
    x => { x.binding.surface = "desktop_app"; },
    x => { x.binding.identityFingerprint = "c".repeat(64); },
  ];
  for (const mutate of mutations) {
    const input = base();
    mutate(input);
    assert.equal(classifyFrameAiSession(input, { now: NOW }).state, "scope_mismatch");
  }
});

test("expired, revoked, or inactive identities never stay connected", () => {
  const expiredMcp = base();
  expiredMcp.mcpSession.expiresAt = "2026-11-08T09:59:59.000Z";
  assert.equal(classifyFrameAiSession(expiredMcp, { now: NOW }).state, "ai_not_joined");

  const revokedBinding = base();
  revokedBinding.binding.revokedAt = "2026-11-08T09:00:00.000Z";
  assert.equal(classifyFrameAiSession(revokedBinding, { now: NOW }).state, "scope_mismatch");

  const expiredBinding = base();
  expiredBinding.binding.expiresAt = "2026-11-08T09:59:59.000Z";
  assert.equal(classifyFrameAiSession(expiredBinding, { now: NOW }).state, "binding_expired");

  const revokedDevice = base();
  revokedDevice.device.status = "revoked";
  assert.equal(classifyFrameAiSession(revokedDevice, { now: NOW }).state, "device_unavailable");
});

test("wake consent is scoped to the exact AI, device and runtime session", () => {
  const input = base();
  input.binding.wakeEnabled = true;
  input.binding.wakeExpiresAt = FUTURE;
  input.wakeConsent = {
    granted: true, deviceId: DEVICE, runtimeSessionId: "different-runtime",
    participantId: PARTICIPANT, expiresAt: FUTURE,
  };
  assert.equal(classifyFrameAiSession(input, { now: NOW }).state, "bound_manual_only");
});

test("every reported state is part of the documented closed set", () => {
  const input = base();
  assert.ok(FRAME_AI_RUNTIME_STATES.includes(classifyFrameAiSession(input, { now: NOW }).state));
  assert.equal(classifyFrameAiSession(base(), { now: -1 }).state, "invalid");
});
