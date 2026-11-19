export type WakeInteractionMode = "off" | "on" | "auto";
export type WakeParticipationMode = "mentions" | "smart" | "task";

export const WAKE_INTERACTION_MODES: readonly WakeInteractionMode[];

export function participationModeForInteractionMode(
  mode: WakeInteractionMode,
): "mentions" | "smart" | null;

export function interactionModeForParticipationMode(
  mode: WakeParticipationMode,
): WakeInteractionMode | null;

export function needsWakeBindingRebind(
  mode: WakeInteractionMode,
  bindingParticipationMode: WakeParticipationMode | undefined,
): boolean;
