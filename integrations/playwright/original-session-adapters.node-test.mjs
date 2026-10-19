import test from "node:test";
import assert from "node:assert/strict";
import { createOriginalSessionAdapter } from "./original-session-adapters.mjs";

test("requires explicit approval callback", () => {
  assert.throws(() => createOriginalSessionAdapter("chatgpt"), /approval callback/);
  assert.throws(() => createOriginalSessionAdapter("unknown", { approval: () => true }), /Unsupported provider/);
});

test("rejects wrong origin without interacting with DOM", async () => {
  const adapter = createOriginalSessionAdapter("claude", { approval: () => true });
  await assert.rejects(
    adapter.ask({ url: () => "https://example.com/chat/123", locator: () => { throw Error("DOM accessed"); } }, "hello"),
    /expected AI provider origin/
  );
});

test("rejects non-conversation landing pages", async () => {
  const adapter = createOriginalSessionAdapter("chatgpt", { approval: () => true });
  await assert.rejects(adapter.ask({ url: () => "https://chatgpt.com/", locator() {} }, "hello"), /existing ChatGPT conversation/);
});

test("refused approval never interacts with the composer", async () => {
  const adapter = createOriginalSessionAdapter("chatgpt", { approval: async () => false });
  const page = { url: () => "https://chatgpt.com/c/example", locator: () => { throw Error("DOM accessed"); } };
  await assert.rejects(adapter.ask(page, "hello"), /not approved/);
});

test("rejects oversized messages before approval", async () => {
  let approvals = 0;
  const adapter = createOriginalSessionAdapter("claude", { approval: () => { approvals++; return true; } });
  await assert.rejects(adapter.ask({ url: () => "https://claude.ai/chat/123", locator() {} }, "x".repeat(10001)), /1-10000/);
  assert.equal(approvals, 0);
});
