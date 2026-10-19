import test from "node:test";
import assert from "node:assert/strict";
import { decryptCredential, encryptCredential } from "./credential-crypto.mjs";

const key = "a".repeat(64);
const credential = "b".repeat(64);

test("AES-GCM credential encryption round-trips and uses a fresh nonce", async () => {
  const first = await encryptCredential(credential, key);
  const second = await encryptCredential(credential, key);
  assert.match(first, /^v1\.[a-f0-9]{24}\.[a-f0-9]+$/);
  assert.notEqual(first, second);
  assert.equal(await decryptCredential(first, key), credential);
});

test("credential ciphertext cannot be decrypted with the wrong key or after tampering", async () => {
  const envelope = await encryptCredential(credential, key);
  await assert.rejects(() => decryptCredential(envelope, "c".repeat(64)));
  const parts = envelope.split(".");
  parts[2] = (parts[2][0] === "a" ? "b" : "a") + parts[2].slice(1);
  await assert.rejects(() => decryptCredential(parts.join("."), key));
});

test("invalid keys and credential envelopes are rejected", async () => {
  await assert.rejects(() => encryptCredential(credential, "short"), /64 hexadecimal/);
  await assert.rejects(() => encryptCredential("not-a-credential", key), /Invalid participant/);
  await assert.rejects(() => decryptCredential("plain-secret", key), /Unsupported/);
});
