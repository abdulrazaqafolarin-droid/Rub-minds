import { decryptCredential, encryptCredential } from "./credential-crypto.mjs";

const validKey = (value) => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);

/** Validate an active encryption key and up to four decryption-only legacy keys. */
export function validateCredentialKeyRing(activeKey, legacyKeys = []) {
  if (!validKey(activeKey)) throw new Error("Invalid active credential encryption key.");
  if (!Array.isArray(legacyKeys) || legacyKeys.length > 4 || legacyKeys.some((key) => !validKey(key))) {
    throw new Error("Invalid legacy credential encryption key ring.");
  }
  const normalized = [activeKey, ...legacyKeys].map((key) => key.toLowerCase());
  if (new Set(normalized).size !== normalized.length) throw new Error("Duplicate credential encryption keys.");
  return Object.freeze(normalized);
}

/** Always encrypt with the active key. Legacy keys are never used for new ciphertext. */
export async function encryptWithKeyRing(credential, activeKey, context = "") {
  validateCredentialKeyRing(activeKey);
  return encryptCredential(credential, activeKey, context);
}

/**
 * Try the active key first, then explicitly configured legacy keys.
 * Context remains authenticated as AES-GCM additional data. This supports
 * ciphertext migration only; deterministic handles/credentials need their own
 * versioned derivation and rotation strategy.
 */
export async function decryptWithKeyRing(envelope, activeKey, legacyKeys = [], context = "") {
  const keys = validateCredentialKeyRing(activeKey, legacyKeys);
  for (const key of keys) {
    try {
      return await decryptCredential(envelope, key, context);
    } catch {
      // Do not reveal which key matched or whether authentication failed.
    }
  }
  throw new Error("Credential authentication failed for every configured encryption key.");
}
