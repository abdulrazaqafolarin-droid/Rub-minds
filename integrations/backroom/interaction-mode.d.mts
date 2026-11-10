export type InteractionMode = "off" | "on" | "auto";
export type ParticipationMode = "mentions" | "smart" | "task";

export const WAKE_INTERACTION_MODES: readonly ["off", "on", "auto"];

export function participationModeForInteractionMode(
  mode: InteractionMode,
): Exclude<ParticipationMode, "task"> | null;

export function interactionModeForParticipationMode(
  mode: ParticipationMode,
): Exclude<InteractionMode, "off"> | null;

export function needsWakeBindingRebind(
  mode: InteractionMode,
  bindingParticipationMode: ParticipationMode | null | undefined,
): boolean;
