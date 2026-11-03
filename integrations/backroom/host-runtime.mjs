/**
 * Runtime-side guard between the group dispatcher and local device adapters.
 * These capabilities are not created by a web page and do not grant OS access.
 * A separately installed local host must attest device/session focus on EVERY call.
 */
const KINDS = new Set(["browser_tab","desktop_app","windows_app","terminal","android_app"]);
const OPS = new Set(["draft","wake","submit","read_result"]);
const NATIVE_WAKE_SURFACES = new Set(["desktop_app","windows_app","android_app"]);
const isText = value => typeof value === "string" && value.length > 0;
import {isCanonicalWakePrompt} from "./coordination-core.mjs";
function denyBeforeEffect(message) {
  const error = new Error(message);
  error.code = "BACKROOM_PREFLIGHT";
  throw error;
}
export function validateHostCapabilities(info) {
  if (!info || typeof info !== "object") throw new TypeError("host capabilities required");
  if (!isText(info.hostId) || !isText(info.deviceLabel)) throw new TypeError("host identity required");
  if (!Array.isArray(info.surfaces) || info.surfaces.some(v => !KINDS.has(v))) throw new TypeError("invalid surfaces");
  if (!Array.isArray(info.operations) || info.operations.some(v => !OPS.has(v))) throw new TypeError("invalid operations");
  if (new Set(info.surfaces).size !== info.surfaces.length || new Set(info.operations).size !== info.operations.length) {
    throw new TypeError("duplicate capabilities");
  }
  return Object.freeze({ hostId: info.hostId, deviceLabel: info.deviceLabel,
    surfaces: Object.freeze([...info.surfaces]), operations: Object.freeze([...info.operations]) });
}
export class LocalExecutionGuard {
  constructor({ host, adapter, permission, isConnected }) {
    this.host = validateHostCapabilities(host);
    if (!adapter || typeof adapter.probe !== "function" || typeof adapter.execute !== "function") {
      throw new TypeError("device adapter must support probe and execute");
    }
    if (typeof permission !== "function" || typeof isConnected !== "function") {
      throw new TypeError("permission and connection checks required");
    }
    this.adapter = adapter;
    this.permission = permission;
    this.isConnected = isConnected;
  }
  async execute({ command, target, beforeEffect }) {
    if (!command || !target || target.hostId !== this.host.hostId ||
      command.hostId !== this.host.hostId || command.targetId !== target.id ||
      command.roomId !== target.roomId || command.spaceId !== target.spaceId ||
      command.sessionId !== target.sessionId || command.identityFingerprint !== target.identityFingerprint ||
      command.targetRevision !== target.revision) {
      denyBeforeEffect("target scope mismatch");
    }
    if (command.operation === "wake" && !isCanonicalWakePrompt(command.text, command.eventId)) {
      denyBeforeEffect("wake operation accepts only the canonical event-bound @RMconnects prompt");
    }
    if (!this.host.surfaces.includes(target.surface) || !this.host.operations.includes(command.operation)) {
      denyBeforeEffect("host capability missing");
    }
    const nativeWake = command.operation === "wake" && NATIVE_WAKE_SURFACES.has(target.surface);
    // Native Send is a one-shot side effect. A native wake cannot proceed on a
    // standing permission or a UI boolean alone: the durable journal and the
    // exact local wake grant must both be acquired immediately before effect.
    if (nativeWake && beforeEffect === undefined) {
      denyBeforeEffect("native wake requires a durable execution seal");
    }
    if (!(await this.isConnected(this.host.hostId))) denyBeforeEffect("host offline");
    if ((await this.permission({ command, target })) !== true) denyBeforeEffect("permission denied");
    const live = await this.adapter.probe({ target, operation: command.operation });
    if (!live || live.focused !== true || live.connected !== true ||
      live.sessionId !== target.sessionId || live.appId !== target.appId ||
      live.surface !== target.surface || live.identityFingerprint !== target.identityFingerprint ||
      !Array.isArray(live.locatorKinds) || !live.locatorKinds.includes(target.locatorKind)) {
      denyBeforeEffect("live target identity/focus mismatch");
    }
    // A durable wake seal and one-shot grant consumption happen only after
    // local connection, permission and focus preflight, immediately before UI.
    let executionSealReserved = false;
    if (beforeEffect !== undefined) {
      if (typeof beforeEffect !== "function") denyBeforeEffect("invalid execution seal callback");
      let permitted = false;
      try { permitted = (await beforeEffect()) === true; } catch { permitted = false; }
      if (!permitted) {
        const error = new Error("Durable execution seal or one-shot wake grant was not acquired.");
        error.code = "BACKROOM_EXECUTION_SEAL_DENIED";
        throw error;
      }
      executionSealReserved = true;
    }
    // The adapter must check identity again immediately before any OS effect.
    // A successful result is only accepted with explicit verification evidence.
    const outcome = await this.adapter.execute({
      command, target, verifiedProbe: live, executionSealReserved,
    });
    if (!outcome || outcome.state !== "completed" || outcome.verified !== true) {
      return { state: "needs_review", result: null };
    }
    return { state: "completed", result: outcome.result ?? null };
  }
}
