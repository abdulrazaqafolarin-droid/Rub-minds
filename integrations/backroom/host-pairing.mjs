import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const CODE_RE = /^[a-f0-9]{32}$/i;
const TOKEN_RE = /^[a-f0-9]{64}$/i;
const sha256 = value => createHash("sha256").update(value, "utf8").digest();
const validOrigin = origin => {
  if (typeof origin !== "string" || !origin || origin === "null") return false;
  try {
    const parsed = new URL(origin);
    return ["http:", "https:"].includes(parsed.protocol) &&
      parsed.origin === origin && !parsed.username && !parsed.password;
  } catch { return false; }
};

/**
 * Ephemeral host-pairing authority. Stores hashes of pairing and session secrets,
 * binds sessions to a single exact browser Origin and has no network listener.
 */
export class HostPairingAuthority {
  #pairingDigest;
  #pairingExpiresAt;
  #pairingUsed = false;
  #attempts = 0;
  #sessions = new Map();
  #now;
  constructor({ allowedOrigins, hostId = randomUUID(), pairingCode, now = () => Date.now(),
    pairingTtlMs = 10 * 60_000, sessionTtlMs = 12 * 60 * 60_000, maxPairAttempts = 8 } = {}) {
    if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0 ||
      allowedOrigins.some(origin => !validOrigin(origin)) || new Set(allowedOrigins).size !== allowedOrigins.length) {
      throw new TypeError("allowedOrigins must be unique exact HTTP(S) origins");
    }
    if (typeof hostId !== "string" || !hostId) throw new TypeError("hostId required");
    if (!Number.isSafeInteger(pairingTtlMs) || pairingTtlMs < 1000 ||
      !Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1000 ||
      !Number.isSafeInteger(maxPairAttempts) || maxPairAttempts < 1) throw new RangeError("invalid pairing limits");
    this.allowedOrigins = Object.freeze([...allowedOrigins]);
    this.hostId = hostId;
    this.#now = now;
    this.pairingCode = pairingCode ?? randomBytes(16).toString("hex");
    if (!CODE_RE.test(this.pairingCode)) throw new TypeError("pairingCode must be 128-bit hexadecimal");
    this.#pairingDigest = sha256(this.pairingCode);
    this.#pairingExpiresAt = this.#now() + pairingTtlMs;
    this.sessionTtlMs = sessionTtlMs;
    this.maxPairAttempts = maxPairAttempts;
  }
  canServeOrigin(origin) { return validOrigin(origin) && this.allowedOrigins.includes(origin); }
  pair({ origin, pairingCode, clientLabel = "Backroom web client" } = {}) {
    if (!this.canServeOrigin(origin)) throw new Error("origin_not_allowed");
    if (this.#attempts >= this.maxPairAttempts) throw new Error("pairing_rate_limited");
    this.#attempts++;
    if (this.#pairingUsed || this.#now() >= this.#pairingExpiresAt) throw new Error("pairing_expired");
    if (typeof pairingCode !== "string" || !CODE_RE.test(pairingCode) ||
      !timingSafeEqual(sha256(pairingCode), this.#pairingDigest)) throw new Error("pairing_invalid");
    if (typeof clientLabel !== "string" || clientLabel.trim().length < 1 || clientLabel.length > 80) {
      throw new Error("invalid_client_label");
    }
    this.#pairingUsed = true;
    const token = randomBytes(32).toString("hex");
    const digest = sha256(token).toString("hex");
    const expiresAt = this.#now() + this.sessionTtlMs;
    this.#sessions.set(digest, { origin, clientLabel: clientLabel.trim(), expiresAt, revoked: false });
    return Object.freeze({ token, hostId: this.hostId, expiresAt, clientLabel: clientLabel.trim() });
  }
  authorize({ origin, token } = {}) {
    if (!this.canServeOrigin(origin) || typeof token !== "string" || !TOKEN_RE.test(token)) return null;
    const digest = sha256(token).toString("hex");
    const session = this.#sessions.get(digest);
    if (!session || session.revoked || session.origin !== origin || this.#now() >= session.expiresAt) return null;
    return Object.freeze({ hostId: this.hostId, origin: session.origin,
      clientLabel: session.clientLabel, expiresAt: session.expiresAt });
  }
  revoke({ origin, token } = {}) {
    const session = this.authorize({ origin, token });
    if (!session) return false;
    const digest = sha256(token).toString("hex");
    const record = this.#sessions.get(digest);
    record.revoked = true;
    return true;
  }
  pairingStatus() {
    return Object.freeze({ available: !this.#pairingUsed && this.#now() < this.#pairingExpiresAt,
      expiresAt: this.#pairingExpiresAt, attemptsRemaining: Math.max(0, this.maxPairAttempts - this.#attempts) });
  }
}
