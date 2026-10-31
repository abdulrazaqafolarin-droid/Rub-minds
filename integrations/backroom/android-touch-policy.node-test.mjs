import test from "node:test";
import assert from "node:assert/strict";
import { validateAndroidTouchMessage, mapNormalizedAndroidPoint } from "./android-touch-policy.mjs";

const sessionId = "123e4567-e89b-42d3-a456-426614174003";
const appPackageName = "com.example.notes";
const base = {
  kind: "touch", sessionId, appPackageName, gesture: "tap",
  from: { x: 0.5, y: 0.5 }, to: { x: 0.5, y: 0.5 }, durationMs: 120
};

test("tap is accepted only for the exact active session, selected app and granted control", () => {
  assert.ok(validateAndroidTouchMessage(base, { sessionId, appPackageName, controlGranted: true }));
  assert.equal(validateAndroidTouchMessage({ ...base, appPackageName: "com..notes" }, { sessionId, appPackageName: "com..notes", controlGranted: true }), null);
  assert.equal(validateAndroidTouchMessage(base, { sessionId, appPackageName, controlGranted: false }), null);
  assert.equal(validateAndroidTouchMessage(base, { sessionId, appPackageName: "com.other.app", controlGranted: true }), null);
  assert.equal(validateAndroidTouchMessage({ ...base, sessionId: "123e4567-e89b-42d3-a456-426614174004" }, { sessionId, appPackageName, controlGranted: true }), null);
});

test("swipes and long presses reject malformed or out-of-frame coordinates", () => {
  const swipe = { ...base, gesture: "swipe", to: { x: 0.5, y: 0.9 }, durationMs: 420 };
  assert.ok(validateAndroidTouchMessage(swipe, { sessionId, appPackageName, controlGranted: true }));
  assert.ok(validateAndroidTouchMessage({ ...base, gesture: "long_press", durationMs: 800 }, { sessionId, appPackageName, controlGranted: true }));
  assert.equal(validateAndroidTouchMessage({ ...swipe, to: { x: 1.1, y: 0.5 } }, { sessionId, appPackageName, controlGranted: true }), null);
  assert.equal(validateAndroidTouchMessage({ ...swipe, durationMs: 20 }, { sessionId, appPackageName, controlGranted: true }), null);
  assert.equal(validateAndroidTouchMessage({ ...base, extra: true }, { sessionId, appPackageName, controlGranted: true }), null);
});

test("normalized points map to the actual accessibility window bounds", () => {
  assert.deepEqual(mapNormalizedAndroidPoint({ x: 0, y: 0 }, { left: 20, top: 40, right: 1020, bottom: 1840 }), { x: 20, y: 40 });
  assert.deepEqual(mapNormalizedAndroidPoint({ x: 1, y: 1 }, { left: 20, top: 40, right: 1020, bottom: 1840 }), { x: 1019, y: 1839 });
  assert.deepEqual(mapNormalizedAndroidPoint({ x: 0.5, y: 0.5 }, { left: 20, top: 40, right: 1020, bottom: 1840 }), { x: 519, y: 939 });
  assert.equal(mapNormalizedAndroidPoint({ x: 2, y: 0.5 }, { left: 0, top: 0, right: 10, bottom: 10 }), null);
});
