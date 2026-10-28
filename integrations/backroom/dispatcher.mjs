/**
 * Local, capability-gated coordination core. This module does not control devices.
 * Real adapters must perform OS-level identity and permission checks before effects.
 */
import { TargetRegistry } from "./target-registry.mjs";
const OPERATIONS = new Set(["draft", "submit", "read_result"]);
const STATES = new Set(["queued", "awaiting_approval", "running", "completed", "failed", "cancelled", "needs_review"]);
const ok = (v) => typeof v === "string" && v.trim().length > 0;
export function validateCommand(command) {
  if (!command || typeof command !== "object") throw new TypeError("command required");
  for (const key of ["id", "eventId", "roomId", "hostId", "spaceId", "sessionId", "identityFingerprint", "targetId", "text"]) {
    if (!ok(command[key])) throw new TypeError(`${key} required`);
  }
  if (!OPERATIONS.has(command.operation)) throw new TypeError("unsupported operation");
  if (!Number.isSafeInteger(command.targetRevision) || command.targetRevision < 1) throw new TypeError("invalid targetRevision");
  if (command.text.length > 12000) throw new RangeError("command too large");
  return Object.freeze({ ...command });
}
export class BackroomDispatcher {
  #jobs = new Map();
  #events = new Map();
  #inflight = new Set();
  constructor({ registry = new TargetRegistry(), adapter, authorize, maxJobs = 200 } = {}) {
    if (!adapter || typeof adapter.execute !== "function") throw new TypeError("adapter.execute required");
    if (typeof authorize !== "function") throw new TypeError("authorize callback required");
    this.registry = registry;
    this.adapter = adapter;
    this.authorize = authorize;
    this.maxJobs = maxJobs;
  }
  enqueue(input) {
    const command = validateCommand(input);
    const prior = this.#jobs.get(command.id);
    if (prior) {
      if (JSON.stringify(prior.command) !== JSON.stringify(command)) throw new Error("command ID conflict");
      return prior.status;
    }
    const eventKey = [command.roomId, command.hostId, command.eventId, command.targetId, command.operation].join(":");
    const eventOwner = this.#events.get(eventKey);
    if (eventOwner) return this.#jobs.get(eventOwner).status;
    if (this.#jobs.size >= this.maxJobs) throw new Error("queue full");
    const status = { id: command.id, state: "queued", attempts: 0 };
    this.#jobs.set(command.id, { command, status });
    this.#events.set(eventKey, command.id);
    return status;
  }
  status(id) { return this.#jobs.get(id)?.status ?? null; }
  cancel(id) {
    const job = this.#jobs.get(id);
    if (!job) return false;
    if (["running", "completed", "needs_review"].includes(job.status.state)) return false;
    job.status = { ...job.status, state: "cancelled" };
    return true;
  }
  async step(id, { approved = false } = {}) {
    const job = this.#jobs.get(id);
    if (!job) throw new Error("unknown command");
    if (!STATES.has(job.status.state)) throw new Error("invalid state");
    if (job.status.state !== "queued" && job.status.state !== "awaiting_approval") return job.status;
    if (this.#inflight.has(id)) return job.status;
    this.#inflight.add(id);
    try {
    const c = job.command;
    const allowed = await this.authorize(c);
    if (job.status.state === 'cancelled') return job.status;
    if (allowed !== true) {
      job.status = { ...job.status, state: "failed", reason: "not_authorized" };
      return job.status;
    }
    if (!approved) {
      job.status = { ...job.status, state: "awaiting_approval" };
      return job.status;
    }
    // Resolve target immediately before any interaction; adapter must check
    // live focus, app identity, capabilities, permissions and consent again.
    let target;
    try { target = this.registry.resolve(c.targetId, {
      roomId: c.roomId, hostId: c.hostId, spaceId: c.spaceId,
      sessionId: c.sessionId, identityFingerprint: c.identityFingerprint,
      expectedRevision: c.targetRevision,
    }); } catch {
      job.status = { ...job.status, state: "failed", reason: "stale_or_wrong_target" };
      return job.status;
    }
    job.status = { ...job.status, state: "running", attempts: job.status.attempts + 1 };
    try {
      const outcome = await this.adapter.execute({ command: c, target });
      if (!outcome || !["completed", "needs_review", "failed"].includes(outcome.state)) {
        throw new Error("adapter did not return a verifiable outcome");
      }
      job.status = { ...job.status, state: outcome.state, result: outcome.result ?? null };
    } catch (error) {
      if (error && error.code === "BACKROOM_PREFLIGHT") {
        job.status = { ...job.status, state: "failed", reason: "device_preflight_denied" };
        return job.status;
      }
      // Ambiguous UI effects are not automatically retried. The host must
      // reconcile visually before creating a new user-authorized command.
      job.status = { ...job.status, state: "needs_review", reason: "effect_unconfirmed" };
    }
    return job.status;
    } finally { this.#inflight.delete(id); }
  }
}
