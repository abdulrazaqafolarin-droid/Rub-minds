const encoder = new TextEncoder();

/** Derive the participant credential in a separate HKDF domain from the MCP handle.
 * Repeated calls for the same opaque handle recover the same credential without
 * storing its plaintext in the database or returning it from a database RPC.
 */
export async function deriveJoinCredential(secretHex, sessionHandle) {
  if (typeof secretHex !== "string" || !/^[a-f0-9]{64}$/i.test(secretHex)) {
    throw new Error("Join credential secret must be 32 bytes of hexadecimal key material.");
  }
  if (typeof sessionHandle !== "string" || !/^[a-f0-9]{64}$/i.test(sessionHandle)) {
    throw new Error("Invalid MCP session handle.");
  }
  const keyBytes = new Uint8Array(32);
  for (let i = 0; i < keyBytes.length; i++) keyBytes[i] = Number.parseInt(secretHex.slice(i * 2, i * 2 + 2), 16);
  const material = await crypto.subtle.importKey("raw", keyBytes, "HKDF", false, ["deriveKey"]);
  const hmacKey = await crypto.subtle.deriveKey({
    name: "HKDF", hash: "SHA-256",
    salt: encoder.encode("rub-minds-mcp-join-credential-salt-v1"),
    info: encoder.encode("rub-minds-mcp-join-credential-v1"),
  }, material, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", hmacKey, encoder.encode("rub-minds-mcp-join-credential-v1:" + sessionHandle.toLowerCase()));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
