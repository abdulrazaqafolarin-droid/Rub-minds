/**
 * Backroom interaction modes are an owner-facing layer over the existing,
 * server-validated participation modes. OFF has no participation mode and
 * must never register or arm a wake binding.
 */
const MODE_TO_PARTICIPATION = Object.freeze({
  on: "mentions",
  auto: "smart",
});

export const WAKE_INTERACTION_MODES = Object.freeze(["off", "on", "auto"]);

export function participationModeForInteractionMode(mode) {
  if (mode === "off") return null;
  if (Object.hasOwn(MODE_TO_PARTICIPATION, mode)) return MODE_TO_PARTICIPATION[mode];
  throw new TypeError("Unknown Backroom interaction mode");
}

export function interactionModeForParticipationMode(mode) {
  if (mode === "mentions") return "on";
  if (mode === "smart") return "auto";
  if (mode === "task") return null;
  throw new TypeError("Unknown Backroom participation mode");
}

export function needsWakeBindingRebind(mode, bindingParticipationMode) {
  const required = participationModeForInteractionMode(mode);
  if (required === null) return false;
  return bindingParticipationMode !== required;
}
