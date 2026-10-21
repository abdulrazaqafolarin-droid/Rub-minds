import test from "node:test";
import assert from "node:assert/strict";
import { deriveJoinCredential } from "./join-credential.mjs";

const key = "a".repeat(64);
const handle = "b".repeat(64);

test("join credential is stable for retrying the same handle", async () => {
  assert.equal(await deriveJoinCredential(key, handle), await deriveJoinCredential(key, handle));
});

test("join credential is 256-bit hex and separate from the handle", async () => {
  const credential = await deriveJoinCredential(key, handle);
  assert.match(credential, /^[a-f0-9]{64}$/);
  assert.notEqual(credential, handle);
});

test("different handles derive different credentials", async () => {
  assert.notEqual(await deriveJoinCredential(key, handle), await deriveJoinCredential(key, "c".repeat(64)));
});

test("invalid key and handle are rejected", async () => {
  await assert.rejects(() => deriveJoinCredential("bad", handle));
  await assert.rejects(() => deriveJoinCredential(key, "bad"));
});
