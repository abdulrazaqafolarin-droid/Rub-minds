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

function makeChatGPTPage(state) {
  const response = {
    waitFor: async () => {
      const started = Date.now();
      while (!state.assistantVisible && Date.now() - started < 1000) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (!state.assistantVisible) throw new Error("response did not appear");
    },
    innerText: async () => state.text,
  };
  const locatorFor = selector => {
    if (selector.includes('data-message-author-role="assistant"')) {
      return {
        count: async () => state.assistantVisible ? 1 : 0,
        nth: () => response,
      };
    }
    if (selector.includes("stop-button") || selector.includes("Stop generating") || selector.includes("Stop response")) {
      return { count: async () => state.generating ? 1 : 0, isVisible: async () => state.generating };
    }
    if (selector.includes("prompt-textarea") || selector.includes("composer-input")) {
      return { count: async () => 1, isVisible: async () => true, fill: async () => {} };
    }
    if (selector.includes("send-button") || selector.includes("Send prompt")) {
      return {
        count: async () => 1,
        isVisible: async () => true,
        isEnabled: async () => true,
        click: async () => {
          state.assistantVisible = true;
          state.generating = true;
          state.text = "Partial";
          state.onSend?.();
        },
      };
    }
    throw new Error("Unexpected selector in adapter test");
  };
  return {
    url: () => "https://chatgpt.com/c/example",
    locator: selector => {
      const item = locatorFor(selector);
      return { ...item, last: () => item };
    },
  };
}

test("returns the completed response rather than a partial streamed response", async () => {
  const state = { assistantVisible: false, text: "", generating: false };
  state.onSend = () => {
    setTimeout(() => { state.text = "Complete answer"; }, 350);
    setTimeout(() => { state.generating = false; }, 650);
  };
  const adapter = createOriginalSessionAdapter("chatgpt", { approval: async () => true, timeoutMs: 5000 });
  assert.equal(await adapter.ask(makeChatGPTPage(state), "hello"), "Complete answer");
});

test("discards partial text if the provider keeps streaming until timeout", async () => {
  const state = { assistantVisible: false, text: "", generating: false };
  const adapter = createOriginalSessionAdapter("chatgpt", { approval: async () => true, timeoutMs: 5000 });
  await assert.rejects(adapter.ask(makeChatGPTPage(state), "hello"), /partial response discarded/);
});
