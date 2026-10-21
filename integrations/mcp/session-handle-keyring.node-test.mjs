import test from "node:test";
import assert from "node:assert/strict";
import { selectSessionHandleForRetry } from "./session-handle-keyring.mjs";
import { deriveModernSessionHandle } from "./session-handle.mjs";

const active = "a".repeat(64);
const previous = "b".repeat(64);
const invite = "c".repeat(64);
const request = "d".repeat(64);

test("same join request after rotation selects the durable old handle", async () => {
  const oldHandle = await deriveModernSessionHandle(previous, invite, "Claude", request);
  const selected = await selectSessionHandleForRetry([active, previous], invite, "Claude", request, async (h) => h === oldHandle);
  assert.equal(selected.handle, oldHandle);
  assert.equal(selected.key, previous);
  assert.equal(selected.existing, true);
});

test("a new join request always selects the active key", async () => {
  const selected = await selectSessionHandleForRetry([active, previous], invite, "Claude", "e".repeat(64), async () => false);
  assert.equal(selected.key, active);
  assert.equal(selected.existing, false);
});

test("a different retry key cannot accidentally select the prior handle", async () => {
  const oldHandle = await deriveModernSessionHandle(previous, invite, "Claude", request);
  const selected = await selectSessionHandleForRetry([active, previous], invite, "Claude", "e".repeat(64), async (h) => h === oldHandle);
  assert.equal(selected.key, active);
  assert.equal(selected.existing, false);
});

test("invalid key rings and missing durable lookup fail closed", async () => {
  await assert.rejects(() => selectSessionHandleForRetry([], invite, "Claude", request, async () => false));
  await assert.rejects(() => selectSessionHandleForRetry([active, active], invite, "Claude", request, async () => false));
  await assert.rejects(() => selectSessionHandleForRetry([active], invite, "Claude", request));
});
