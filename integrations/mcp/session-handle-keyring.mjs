import { deriveModernSessionHandle } from "./session-handle.mjs";

/**
 * Derive handles using [activeKey, ...legacyKeys]. Reuse an existing handle
 * when the same request was created under a previous key; otherwise choose
 * the active key for a new join. lookupExisting must check the durable
 * session digest, including expired/terminated tombstones, not only active rows.
 */
export async function selectSessionHandleForRetry(keys, inviteToken, agentLabel, joinRequestKey, lookupExisting) {
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 5 ||
      keys.some((key) => typeof key !== "string" || !/^[a-f0-9]{64}$/i.test(key)) ||
      new Set(keys.map((key) => key.toLowerCase())).size !== keys.length) {
    throw new Error("Invalid session handle key ring.");
  }
  if (typeof lookupExisting !== "function") throw new Error("A durable session lookup is required.");
  const candidates = [];
  for (const key of keys) {
    candidates.push({
      key: key.toLowerCase(),
      handle: await deriveModernSessionHandle(key, inviteToken, agentLabel, joinRequestKey),
    });
  }
  for (const candidate of candidates) {
    if (await lookupExisting(candidate.handle)) return { ...candidate, existing: true };
  }
  return { ...candidates[0], existing: false };
}
