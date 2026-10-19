const encoder = new TextEncoder();
const decoder = new TextDecoder();

function keyBytesFromHex(keyHex) {
  if (typeof keyHex !== "string" || !/^[a-f0-9]{64}$/i.test(keyHex)) {
    throw new Error("RUB_MINDS_MCP_SESSION_ENCRYPTION_KEY must be 64 hexadecimal characters (32 random bytes).");
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(keyHex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value) {
  if (!/^(?:[a-f0-9]{2})+$/i.test(value)) throw new Error("Invalid encrypted credential encoding.");
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function importKey(keyHex, usages) {
  return crypto.subtle.importKey("raw", keyBytesFromHex(keyHex), { name: "AES-GCM" }, false, usages);
}

/** Encrypt a participant credential before it is stored in the database. */
export async function encryptCredential(credential, keyHex) {
  if (typeof credential !== "string" || !/^[a-f0-9]{64}$/i.test(credential)) {
    throw new Error("Invalid participant credential.");
  }
  const key = await importKey(keyHex, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(credential));
  return "v1." + toHex(iv) + "." + toHex(new Uint8Array(ciphertext));
}

/** Decrypt a stored credential; authentication failure throws instead of returning corrupt data. */
export async function decryptCredential(envelope, keyHex) {
  if (typeof envelope !== "string") throw new Error("Invalid encrypted credential.");
  const parts = envelope.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("Unsupported encrypted credential version.");
  const iv = fromHex(parts[1]);
  if (iv.length !== 12) throw new Error("Invalid encrypted credential nonce.");
  const ciphertext = fromHex(parts[2]);
  const key = await importKey(keyHex, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  const credential = decoder.decode(plaintext);
  if (!/^[a-f0-9]{64}$/i.test(credential)) throw new Error("Decrypted participant credential is invalid.");
  return credential;
}
