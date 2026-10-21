import test from "node:test";
import assert from "node:assert/strict";
import { encryptWithKeyRing, decryptWithKeyRing, validateCredentialKeyRing } from "./credential-keyring.mjs";

const oldKey = "a".repeat(64);
const activeKey = "b".repeat(64);
const credential = "c".repeat(64);
const context = "session-digest-123";

test("legacy ciphertext remains decryptable while new writes use active key", async () => {
  const oldEnvelope = await encryptWithKeyRing(credential, oldKey, context);
  assert.equal(await decryptWithKeyRing(oldEnvelope, activeKey, [oldKey], context), credential);
  const newEnvelope = await encryptWithKeyRing(credential, activeKey, context);
  assert.equal(await decryptWithKeyRing(newEnvelope, activeKey, [oldKey], context), credential);
  await assert.rejects(() => decryptWithKeyRing(newEnvelope, oldKey, [], context));
});

test("wrong context and tampered ciphertext fail closed", async () => {
  const envelope = await encryptWithKeyRing(credential, oldKey, context);
  await assert.rejects(() => decryptWithKeyRing(envelope, activeKey, [oldKey], "other-session"));
  const last = envelope.at(-1);
  const tampered = envelope.slice(0, -1) + (last === "0" ? "1" : "0");
  await assert.rejects(() => decryptWithKeyRing(tampered, activeKey, [oldKey], context));
});

test("key rings reject malformed, duplicate, and oversized configurations", () => {
  assert.throws(() => validateCredentialKeyRing("bad"));
  assert.throws(() => validateCredentialKeyRing(activeKey, [activeKey]));
  assert.throws(() => validateCredentialKeyRing(activeKey, ["bad"]));
  assert.throws(() => validateCredentialKeyRing(activeKey, Array(5).fill(oldKey)));
});
