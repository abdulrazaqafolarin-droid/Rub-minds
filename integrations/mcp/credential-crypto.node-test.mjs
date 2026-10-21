import test from "node:test";
import assert from "node:assert/strict";
import { decryptCredential, encryptCredential } from "./credential-crypto.mjs";
import { deriveModernSessionHandle } from "./session-handle.mjs";

const key = "a".repeat(64);
const credential = "b".repeat(64);
const context = "mcp-session-digest-123";

test("AES-GCM credential encryption round-trips and uses a fresh nonce", async () => {
  const first = await encryptCredential(credential, key, context);
  const second = await encryptCredential(credential, key, context);
  assert.match(first, /^v1\.[a-f0-9]{24}\.[a-f0-9]+$/);
  assert.notEqual(first, second);
  assert.equal(await decryptCredential(first, key, context), credential);
});

test("stateless session handles are opaque, deterministic for retries, and input-bound", async () => {
  const secret = "a".repeat(64);
  const invite = "b".repeat(64);
  const key = "c".repeat(64);
  const handle = await deriveModernSessionHandle(secret, invite, "Research Agent", key);
  assert.match(handle, /^[a-f0-9]{64}$/);
  assert.equal(await deriveModernSessionHandle(secret, invite, "Research Agent", key), handle);
  assert.equal(await deriveModernSessionHandle(secret, invite.toUpperCase(), " Research Agent ", key.toUpperCase()), handle);
  assert.notEqual(await deriveModernSessionHandle(secret, invite, "Different Agent", key), handle);
  assert.notEqual(await deriveModernSessionHandle(secret, invite, "Research Agent", "d".repeat(64)), handle);
  assert.notEqual(await deriveModernSessionHandle("e".repeat(64), invite, "Research Agent", key), handle);
  await assert.rejects(() => deriveModernSessionHandle("short", invite, "Research Agent", key));
});

test("credential ciphertext cannot be decrypted with the wrong key, context, or after tampering", async () => {
  const envelope = await encryptCredential(credential, key, context);
  await assert.rejects(() => decryptCredential(envelope, "c".repeat(64), context));
  await assert.rejects(() => decryptCredential(envelope, key, "different-session"));
  const parts = envelope.split(".");
  parts[2] = (parts[2][0] === "a" ? "b" : "a") + parts[2].slice(1);
  await assert.rejects(() => decryptCredential(parts.join("."), key, context));
});

test("invalid keys and credential envelopes are rejected", async () => {
  await assert.rejects(() => encryptCredential(credential, "short", context), /64 hexadecimal/);
  await assert.rejects(() => encryptCredential("not-a-credential", key, context), /Invalid participant/);
  await assert.rejects(() => decryptCredential("plain-secret", key, context), /Unsupported/);
});
