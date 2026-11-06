import test from "node:test";
import assert from "node:assert/strict";
import { TargetRegistry, SURFACES, validateTarget } from "./target-registry.mjs";

const base = (overrides = {}) => ({
  id: "target-1", roomId: "room-1", spaceId: "space-1",
  hostId: "host-1", sessionId: "session-1", appId: "com.example.ai",
  identityFingerprint: "app:window:session-1",
  surface: "android_app", locatorKind: "accessibility",
  locatorValue: "compose-input", revision: 1, ...overrides,
});
const scope = { roomId: "room-1", spaceId: "space-1", hostId: "host-1",
  sessionId: "session-1", identityFingerprint: "app:window:session-1",
  expectedRevision: 1 };

test("all requested UI surfaces have a valid target registration path", () => {
  const kinds = {
    browser_tab: "dom", desktop_app: "accessibility",
    windows_app: "accessibility", terminal: "terminal_pty",
    android_app: "accessibility",
  };
  assert.deepEqual(SURFACES, Object.keys(kinds));
  for (const surface of SURFACES) {
    const registry = new TargetRegistry();
    const target = registry.register(base({ surface, locatorKind: kinds[surface] }));
    assert.equal(registry.resolve(target.id, scope), target);
    assert.equal(registry.listForSpace(scope).length, 1);
  }
});

test("drag-selected screen regions work on all surfaces but require bounded dimensions", () => {
  for (const surface of SURFACES) {
    const region = { x: 50, y: 30, width: 250, height: 90, displayWidth: 1080, displayHeight: 1920 };
    assert.equal(validateTarget(base({ surface, locatorKind: "screen_region", locatorValue: "drag-selection", region })).region.width, 250);
    assert.throws(() => validateTarget(base({
      surface, locatorKind: "screen_region", locatorValue: "drag-selection",
      region: { ...region, x: 1000 },
    })), /fit a declared display/);
  }
});

test("unrelated room, host, space and session cannot resolve registered target", () => {
  const r = new TargetRegistry();
  r.register(base());
  for (const key of ["roomId", "hostId", "spaceId", "sessionId", "identityFingerprint", "expectedRevision"]) {
    assert.throws(() => r.resolve("target-1", { ...scope, [key]: "wrong" }), /mismatch|changed/);
  }
});

test("provider-conversation identity is preserved and resolved only for the exact digest", () => {
  const digest = "a".repeat(64);
  const r = new TargetRegistry();
  const registered = r.register(base({ providerConversationIdentityDigest: digest }));
  assert.equal(registered.providerConversationIdentityDigest, digest);
  assert.equal(r.resolve("target-1", { ...scope,
    expectedProviderConversationIdentityDigest: digest,
  }), registered);
  assert.throws(() => r.resolve("target-1", { ...scope,
    expectedProviderConversationIdentityDigest: "b".repeat(64),
  }), /provider conversation identity changed/);
  assert.throws(() => validateTarget(base({ providerConversationIdentityDigest: "not-a-digest" })),
    /providerConversationIdentityDigest/);
  const { providerConversationIdentityDigest: _omitted, ...withoutDigest } = base();
  assert.equal(validateTarget(withoutDigest).providerConversationIdentityDigest, undefined);
});

test("app identity changes require explicit rebind with optimistic revision", () => {
  const r = new TargetRegistry();
  r.register(base());
  assert.throws(() => r.rebind("target-1", base(), { expectedRevision: 0 }), /stale/);
  assert.throws(() => r.rebind("target-1", base({ roomId: "other" }), { expectedRevision: 1 }), /ownership/);
  const next = r.rebind("target-1", base({
    sessionId: "session-2", identityFingerprint: "app:window:session-2",
    locatorValue: "new-input",
  }), { expectedRevision: 1 });
  assert.equal(next.revision, 2);
  assert.throws(() => r.resolve("target-1", scope), /changed/);
  assert.equal(r.resolve("target-1", {
    ...scope, sessionId: "session-2", identityFingerprint: "app:window:session-2",
    expectedRevision: 2,
  }), next);
});

test("reject mismatched locator types, duplicates, stale deletion and unscoped deletion", () => {
  assert.throws(() => validateTarget(base({ surface: "android_app", locatorKind: "dom" })), /unsupported/);
  assert.throws(() => validateTarget(base({ surface: "terminal", locatorKind: "dom" })), /unsupported/);
  const r = new TargetRegistry();
  r.register(base());
  assert.throws(() => r.register(base()), /already registered/);
  assert.throws(() => r.unregister("target-1", { roomId: "wrong", hostId: "host-1" }), /ownership/);
  assert.equal(r.unregister("target-1", { roomId: "room-1", hostId: "host-1" }), true);
  assert.throws(() => r.resolve("target-1", scope), /missing/);
});
