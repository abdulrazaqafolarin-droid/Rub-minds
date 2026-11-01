import test from "node:test";
import assert from "node:assert/strict";
import { deriveModernSessionHandle } from "./session-handle.mjs";
import { deriveJoinCredential } from "./join-credential.mjs";

const key = "a".repeat(64);
const invite = "b".repeat(64);
const requestKey = "c".repeat(64);

test("same invitation and retry key produce the same handle and participant credential", async () => {
  const first = await deriveModernSessionHandle(key, invite, "Claude", requestKey);
  const retry = await deriveModernSessionHandle(key, invite.toUpperCase(), " Claude ", requestKey.toUpperCase());
  assert.equal(first, retry);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(await deriveJoinCredential(key, first, requestKey), await deriveJoinCredential(key, retry, requestKey));
});

test("separate requests, invitations, labels and secrets cannot reuse a handle", async () => {
  const base = await deriveModernSessionHandle(key, invite, "Claude", requestKey);
  for (const changed of [
    [key, invite, "Claude", "d".repeat(64)],
    [key, "e".repeat(64), "Claude", requestKey],
    [key, invite, "ChatGPT", requestKey],
    ["f".repeat(64), invite, "Claude", requestKey],
  ]) assert.notEqual(base, await deriveModernSessionHandle(...changed));
});

test("a rotated secret breaks deterministic retry compatibility and must be handled before release", async () => {
  const oldHandle = await deriveModernSessionHandle(key, invite, "Claude", requestKey);
  const newHandle = await deriveModernSessionHandle("f".repeat(64), invite, "Claude", requestKey);
  assert.notEqual(oldHandle, newHandle);
  assert.notEqual(await deriveJoinCredential(key, oldHandle, requestKey), await deriveJoinCredential("f".repeat(64), newHandle, requestKey));
});

test("invalid invitation, secret, label and retry key fail closed", async () => {
  for (const args of [
    ["bad", invite, "Claude", requestKey],
    [key, "bad", "Claude", requestKey],
    [key, invite, " ", requestKey],
    [key, invite, "Claude", "bad"],
  ]) await assert.rejects(() => deriveModernSessionHandle(...args));
});
