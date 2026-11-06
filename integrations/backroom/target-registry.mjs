/**
 * Backroom universal interaction-target registry (platform-agnostic foundation).
 *
 * A registered target identifies WHERE an authorized host adapter may interact;
 * it does not grant permission or perform input. Browser, desktop, terminal,
 * Windows app, and Android app targets share this contract.
 *
 * Coordinates are only a user-selected fallback, never proof of identity.
 * Adapter implementations must independently validate window/app identity,
 * active session, accessibility or DOM locator and operation permissions.
 */
export const SURFACES = Object.freeze([
  "browser_tab", "desktop_app", "windows_app", "terminal", "android_app",
]);
export const LOCATOR_KINDS = Object.freeze([
  "dom", "accessibility", "terminal_pty", "screen_region",
]);
const SURFACE_KINDS = new Set(SURFACES);
const LOCATOR_SET = new Set(LOCATOR_KINDS);
const compatible = {
  browser_tab: new Set(["dom", "accessibility", "screen_region"]),
  desktop_app: new Set(["accessibility", "screen_region"]),
  windows_app: new Set(["accessibility", "screen_region"]),
  terminal: new Set(["terminal_pty", "accessibility", "screen_region"]),
  android_app: new Set(["accessibility", "screen_region"]),
};
const isNonempty = (v) => typeof v === "string" && v.trim().length > 0;
const PROVIDER_IDENTITY_DIGEST = /^[a-f0-9]{64}$/;
const fail = (message) => { throw new TypeError(message); };
function validateRegion(region) {
  if (!region || typeof region !== "object" ||
    !["x", "y", "width", "height"].every((k) => Number.isFinite(region[k])) ||
    region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0) {
    fail("screen_region requires finite nonnegative x/y and positive width/height");
  }
  if (!Number.isFinite(region.displayWidth) || !Number.isFinite(region.displayHeight) ||
    region.displayWidth <= 0 || region.displayHeight <= 0 ||
    region.x + region.width > region.displayWidth ||
    region.y + region.height > region.displayHeight) {
    fail("screen_region must fit a declared display size");
  }
}
export function validateTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) fail("target object required");
  for (const key of ["id", "roomId", "spaceId", "hostId", "sessionId", "appId", "locatorValue"]) {
    if (!isNonempty(target[key])) fail(`${key} is required`);
  }
  if (!SURFACE_KINDS.has(target.surface)) fail("unknown surface");
  if (!LOCATOR_SET.has(target.locatorKind) ||
    !compatible[target.surface].has(target.locatorKind)) fail("unsupported locator for surface");
  if (target.locatorKind === "screen_region") validateRegion(target.region);
  if (target.locatorKind !== "screen_region" && target.region !== undefined) {
    fail("region is only allowed for screen_region");
  }
  if (!Number.isSafeInteger(target.revision) || target.revision < 1) fail("revision must be positive");
  // A stable app/window/session identity is mandatory; foreground coordinates
  // alone must never select a different application following a focus change.
  if (!isNonempty(target.identityFingerprint)) fail("identityFingerprint required");
  if (target.providerConversationIdentityDigest !== undefined &&
    (typeof target.providerConversationIdentityDigest !== "string" ||
      !PROVIDER_IDENTITY_DIGEST.test(target.providerConversationIdentityDigest))) {
    fail("providerConversationIdentityDigest must be a SHA-256 digest");
  }
  return Object.freeze({
    id: target.id, roomId: target.roomId, spaceId: target.spaceId,
    hostId: target.hostId, sessionId: target.sessionId,
    surface: target.surface, appId: target.appId,
    identityFingerprint: target.identityFingerprint,
    ...(target.providerConversationIdentityDigest !== undefined
      ? { providerConversationIdentityDigest: target.providerConversationIdentityDigest } : {}),
    locatorKind: target.locatorKind, locatorValue: target.locatorValue,
    ...(target.locatorKind === "screen_region" ? { region: Object.freeze({
      x: target.region.x, y: target.region.y, width: target.region.width,
      height: target.region.height, displayWidth: target.region.displayWidth,
      displayHeight: target.region.displayHeight,
    }) } : {}),
    revision: target.revision,
  });
}
export class TargetRegistry {
  #targets = new Map();
  register(candidate) {
    const target = validateTarget(candidate);
    if (this.#targets.has(target.id)) throw new Error("target already registered; use rebind");
    this.#targets.set(target.id, target);
    return target;
  }
  rebind(id, replacement, { expectedRevision } = {}) {
    const previous = this.#targets.get(id);
    if (!previous) throw new Error("unknown target");
    if (expectedRevision !== previous.revision) throw new Error("stale target revision");
    // Rebinding cannot move an existing target across tenants or spaces.
    const next = validateTarget({ ...replacement, id, revision: previous.revision + 1 });
    for (const key of ["roomId", "spaceId", "hostId"]) {
      if (next[key] !== previous[key]) throw new Error("target ownership cannot change");
    }
    this.#targets.set(id, next);
    return next;
  }
  unregister(id, { roomId, hostId } = {}) {
    const old = this.#targets.get(id);
    if (!old) return false;
    if (old.roomId !== roomId || old.hostId !== hostId) throw new Error("target ownership mismatch");
    return this.#targets.delete(id);
  }
  resolve(id, { roomId, hostId, spaceId, sessionId, identityFingerprint,
    expectedProviderConversationIdentityDigest, expectedRevision } = {}) {
    const target = this.#targets.get(id);
    if (!target) throw new Error("target missing or revoked");
    if (target.roomId !== roomId || target.hostId !== hostId || target.spaceId !== spaceId) {
      throw new Error("target scope mismatch");
    }
    if (target.sessionId !== sessionId || target.identityFingerprint !== identityFingerprint) {
      throw new Error("target identity changed; re-register typing area");
    }
    if (expectedProviderConversationIdentityDigest !== undefined &&
      target.providerConversationIdentityDigest !== expectedProviderConversationIdentityDigest) {
      throw new Error("provider conversation identity changed; re-register this exact conversation");
    }
    if (target.revision !== expectedRevision) throw new Error("target revision changed");
    return target;
  }
  listForSpace({ roomId, hostId, spaceId }) {
    return [...this.#targets.values()].filter((target) =>
      target.roomId === roomId && target.hostId === hostId && target.spaceId === spaceId);
  }
}
