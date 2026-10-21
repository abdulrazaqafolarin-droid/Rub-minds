const encoder = new TextEncoder();

function stableStringify(value) {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stableStringify(value[key])).join(",") + "}";
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

/** Derive an opaque, bounded-lifetime handle with a key separated from AES-GCM. */
export async function deriveModernSessionHandle(secretHex, inviteToken, agentLabel, joinRequestKey) {
  if (typeof secretHex !== "string" || !/^[a-f0-9]{64}$/i.test(secretHex)) throw new Error("Session handle secret must be 32 bytes of hexadecimal key material.");
  if (typeof inviteToken !== "string" || !/^[a-f0-9]{64}$/i.test(inviteToken)) throw new Error("Invalid invitation token.");
  if (typeof agentLabel !== "string" || !agentLabel.trim() || typeof joinRequestKey !== "string" || !/^[a-f0-9]{64}$/i.test(joinRequestKey)) throw new Error("Invalid join idempotency inputs.");
  const keyBytes = new Uint8Array(32);
  for (let i = 0; i < keyBytes.length; i++) keyBytes[i] = Number.parseInt(secretHex.slice(i * 2, i * 2 + 2), 16);
  const material = await crypto.subtle.importKey("raw", keyBytes, "HKDF", false, ["deriveKey"]);
  const hmacKey = await crypto.subtle.deriveKey({
    name: "HKDF", hash: "SHA-256",
    salt: encoder.encode("rub-minds-mcp-handle-salt-v1"),
    info: encoder.encode("rub-minds-mcp-handle-v1"),
  }, material, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]);
  const message = stableStringify({
    invite_token: inviteToken.toLowerCase(),
    agent_label: agentLabel.trim(),
    join_request_key: joinRequestKey.toLowerCase(),
  });
  const signature = await crypto.subtle.sign("HMAC", hmacKey, encoder.encode(message));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
