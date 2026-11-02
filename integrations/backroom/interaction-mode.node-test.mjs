import test from "node:test";
import assert from "node:assert/strict";
import {
  WAKE_INTERACTION_MODES,
  participationModeForInteractionMode,
  interactionModeForParticipationMode,
  needsWakeBindingRebind,
} from "./interaction-mode.mjs";

test("Off has no participation mode and cannot be translated into an armed mode", () => {
  assert.deepEqual(WAKE_INTERACTION_MODES, ["off", "on", "auto"]);
  assert.equal(participationModeForInteractionMode("off"), null);
  assert.equal(needsWakeBindingRebind("off", "mentions"), false);
});

test("On maps to mention-only delivery", () => {
  assert.equal(participationModeForInteractionMode("on"), "mentions");
  assert.equal(interactionModeForParticipationMode("mentions"), "on");
  assert.equal(needsWakeBindingRebind("on", "mentions"), false);
  assert.equal(needsWakeBindingRebind("on", "smart"), true);
});

test("Auto maps to smart human-message delivery", () => {
  assert.equal(participationModeForInteractionMode("auto"), "smart");
  assert.equal(interactionModeForParticipationMode("smart"), "auto");
  assert.equal(needsWakeBindingRebind("auto", "smart"), false);
  assert.equal(needsWakeBindingRebind("auto", "mentions"), true);
});

test("task-only server participation is not misrepresented as On or Auto", () => {
  assert.equal(interactionModeForParticipationMode("task"), null);
  assert.throws(() => participationModeForInteractionMode("task"), /Unknown/);
});

test("unknown modes fail closed", () => {
  assert.throws(() => participationModeForInteractionMode("always"), /Unknown/);
  assert.throws(() => interactionModeForParticipationMode("always"), /Unknown/);
});
