import test from "node:test";
import assert from "node:assert/strict";
import { deriveJoinCredential } from "./join-credential.mjs";

const key = "a".repeat(64);
const handle = "b".repeat(64);
const requestKey = "d".repeat(64);
const retryKey = "e".repeat(64);

test("join credential is stable for retrying the same handle", async () => {
  assert.equal(await deriveJoinCredential(key, handle, requestKey), await deriveJoinCredential(key, handle, requestKey));
});

test("join credential is 256-bit hex and separate from the handle", async () => {
  const credential = await deriveJoinCredential(key, handle, requestKey);
  assert.match(credential, /^[a-f0-9]{64}$/);
  assert.notEqual(credential, handle);
});

test("different handles derive different credentials", async () => {
  assert.notEqual(await deriveJoinCredential(key, handle, requestKey), await deriveJoinCredential(key, "c".repeat(64), requestKey));
});

test("invalid key and handle are rejected", async () => {
  await assert.rejects(() => deriveJoinCredential("bad", handle, requestKey));
  await assert.rejects(() => deriveJoinCredential(key, "bad", requestKey));
});

test("different rejoin request keys rotate the participant credential for the same session handle", async () => {
  const original = await deriveJoinCredential(key, handle, requestKey);
  const rebound = await deriveJoinCredential(key, handle, retryKey);
  assert.notEqual(rebound, original,
    "a new provider participant credential must not collide with a revoked unique credential digest");
  assert.equal(rebound, await deriveJoinCredential(key, handle, retryKey),
    "retrying the same rejoin request must reproduce its credential");
});

test("join credential requires a valid idempotency key", async () => {
  await assert.rejects(() => deriveJoinCredential(key, handle));
  await assert.rejects(() => deriveJoinCredential(key, handle, "invalid"));
});
