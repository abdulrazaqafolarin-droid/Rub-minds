/**
 * Device-frame -> AI-session association policy.
 *
 * This is display/acceptance logic only, never a permission boundary. The
 * Edge Functions and RLS-backed database must repeat every authorization
 * check before creating a binding, delivering an event, or touching a device.
 *
 * The model deliberately has no browser-host identifier: a device frame binds
 * directly to a joined group AI participant and an attested runtime session.
 */
const APP_SURFACES = new Set(["android_app", "desktop_app", "windows_app"]);
const SURFACES = new Set([...APP_SURFACES, "terminal"]);
const AI_KINDS = new Set(["original_session", "model", "external_agent"]);
const HEX_256 = /^[a-f0-9]{64}$/i;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isFuture(value, now) {
  if (!hasText(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > now;
}

function output(state, reason, flags = {}) {
  return Object.freeze({
    state,
    reason,
    canUseGroupTools: flags.canUseGroupTools === true,
    frameBindingActive: flags.frameBindingActive === true,
    canPollGroupEventsWhileActive: flags.canPollGroupEventsWhileActive === true,
    canAutoWakeFrame: flags.canAutoWakeFrame === true,
  });
}

/**
 * Classifies whether one existing, joined AI participant is attached to the
 * exact selected app conversation or terminal process in a device frame.
 *
 * Required identities are opaque IDs/digests; no conversation text, provider
 * cookies, credentials or MCP bearer handles belong in this input.
 */
export function classifyFrameAiSession(input, { now = Date.now() } = {}) {
  if (!isRecord(input) || !Number.isSafeInteger(now) || now < 0) {
    return output("invalid", "invalid_policy_input");
  }

  const { roomId, surface, participant, mcpSession, device, runtime, binding, wakeConsent } = input;
  if (!hasText(roomId) || !SURFACES.has(surface)) {
    return output("invalid", "invalid_room_or_surface");
  }

  // App inventory and a device login are not an AI group membership.
  if (!isRecord(participant) || !AI_KINDS.has(participant.kind) ||
      participant.status !== "active" || participant.roomId !== roomId ||
      !hasText(participant.participantId)) {
    return output("ai_not_joined", "active_ai_participant_required");
  }

  if (!isRecord(mcpSession) ||
      mcpSession.participantId !== participant.participantId ||
      mcpSession.roomId !== roomId || mcpSession.terminatedAt != null ||
      !isFuture(mcpSession.expiresAt, now) || !hasText(mcpSession.sessionId)) {
    return output("ai_not_joined", "live_joined_mcp_session_required");
  }

  const mcpFlags = { canUseGroupTools: true, canPollGroupEventsWhileActive: true };
  if (!isRecord(device) || device.roomId !== roomId ||
      device.status !== "active" ||
      !hasText(device.deviceId)) {
    return output("device_unavailable", "approved_device_in_this_group_required", mcpFlags);
  }

  if (!isRecord(runtime) || runtime.status !== "active" ||
      runtime.deviceId !== device.deviceId || runtime.roomId !== roomId ||
      runtime.surface !== surface || !hasText(runtime.sessionId) ||
      !hasText(runtime.appId) || !hasText(runtime.identityFingerprint)) {
    return output("runtime_unavailable", "exact_live_frame_runtime_required", mcpFlags);
  }

  if (!isRecord(binding)) {
    return output("ai_joined_unbound", "bind_this_ai_session_to_the_selected_frame_runtime", mcpFlags);
  }

  if (binding.revokedAt != null || binding.roomId !== roomId ||
      binding.participantId !== participant.participantId ||
      binding.mcpSessionId !== mcpSession.sessionId ||
      binding.deviceId !== device.deviceId ||
      binding.runtimeSessionId !== runtime.sessionId ||
      binding.surface !== surface || binding.appId !== runtime.appId ||
      binding.identityFingerprint !== runtime.identityFingerprint) {
    return output("scope_mismatch", "frame_binding_identity_mismatch", mcpFlags);
  }
  if (!isFuture(binding.expiresAt, now)) {
    return output("binding_expired", "frame_binding_expired_or_invalid", mcpFlags);
  }

  const terminal = surface === "terminal";
  const runtimeIdentityVerified = terminal
    ? runtime.processIdentityVerified === true &&
      binding.processIdentityFingerprint === runtime.identityFingerprint
    : runtime.providerConversationIdentityVerified === true &&
      HEX_256.test(binding.providerConversationIdentityDigest || "");

  if (!runtimeIdentityVerified) {
    return output("bound_draft_only", terminal
      ? "terminal_process_identity_not_verified"
      : "provider_conversation_identity_not_verified", {
      ...mcpFlags,
      frameBindingActive: true,
    });
  }

  // Terminal AI clients join and exchange group messages through their own MCP
  // session. A PTY is not a provider composer and never receives native Send.
  if (terminal) {
    return output("terminal_connected", "terminal_ai_uses_its_joined_mcp_session", {
      ...mcpFlags,
      frameBindingActive: true,
      canPollGroupEventsWhileActive: true,
      canAutoWakeFrame: false,
    });
  }

  const consentActive = isRecord(wakeConsent) &&
    wakeConsent.granted === true &&
    wakeConsent.deviceId === device.deviceId &&
    wakeConsent.runtimeSessionId === runtime.sessionId &&
    wakeConsent.participantId === participant.participantId &&
    isFuture(wakeConsent.expiresAt, now);
  const bindingWakeActive = binding.wakeEnabled === true &&
    isFuture(binding.wakeExpiresAt, now);

  if (!consentActive || !bindingWakeActive) {
    return output("bound_manual_only", "separate_device_and_group_wake_consent_required", {
      ...mcpFlags,
      frameBindingActive: true,
    });
  }

  return output("native_wake_ready", "exact_provider_conversation_and_consent_verified", {
    ...mcpFlags,
    frameBindingActive: true,
    canAutoWakeFrame: true,
  });
}

export const FRAME_AI_RUNTIME_STATES = Object.freeze([
  "invalid",
  "ai_not_joined",
  "device_unavailable",
  "runtime_unavailable",
  "ai_joined_unbound",
  "scope_mismatch",
  "binding_expired",
  "bound_draft_only",
  "bound_manual_only",
  "terminal_connected",
  "native_wake_ready",
]);

export const FRAME_AI_RUNTIME_SURFACES = Object.freeze([
  "android_app",
  "desktop_app",
  "windows_app",
  "terminal",
]);
