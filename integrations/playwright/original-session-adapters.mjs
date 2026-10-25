/**
 * Opt-in browser adapters for an ALREADY OPEN, authenticated original conversation.
 * Experimental: selectors may change; never log page content, tokens, or cookies.
 * Does not create sessions, bypass login, or run unattended.
 */
const PROVIDERS = {
  chatgpt: {
    hosts: new Set(["chatgpt.com", "chat.openai.com"]),
    composer: ['#prompt-textarea', '[contenteditable="true"][data-testid="composer-input"]'],
    send: ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]'],
    assistant: ['[data-message-author-role="assistant"]'],
    generating: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop generating"]', 'button[aria-label*="Stop response"]'],
  },
  claude: {
    hosts: new Set(["claude.ai"]),
    composer: ['[contenteditable="true"].ProseMirror', '[contenteditable="true"][data-placeholder]'],
    send: ['button[aria-label="Send message"]', 'button[data-testid="send-button"]'],
    assistant: ['[data-testid="assistant-message"]', '[data-is-streaming="false"] .font-claude-message'],
    generating: ['button[aria-label*="Stop"]', 'button[data-testid="stop-button"]'],
  },
};

function assertPage(page, provider) {
  if (!page || typeof page.url !== "function" || typeof page.locator !== "function") {
    throw new TypeError("A real Playwright Page is required");
  }
  const url = new URL(page.url());
  if (url.protocol !== "https:" || !PROVIDERS[provider].hosts.has(url.hostname)) {
    throw new Error("Page is not on the expected AI provider origin");
  }
  if (!url.pathname.includes("/c/") && provider === "chatgpt") {
    throw new Error("Open the existing ChatGPT conversation first");
  }
  if (!url.pathname.includes("/chat/") && provider === "claude") {
    throw new Error("Open the existing Claude conversation first");
  }
}

async function findVisible(page, selectors) {
  for (const selector of selectors) {
    const item = page.locator(selector).last();
    if (await item.count() && await item.isVisible()) return item;
  }
  throw new Error("Provider UI changed or conversation is not ready; no message sent");
}

async function isGenerating(page, selectors) {
  for (const selector of selectors) {
    const item = page.locator(selector).last();
    if (await item.count() && await item.isVisible()) return true;
  }
  return false;
}

/**
 * Wait until the new response is non-empty, no provider stop/generation control
 * is visible, and the text remains unchanged for a settling window. This reduces
 * the chance of returning a partial streamed response; it is not a substitute
 * for real authenticated provider-browser validation.
 */
async function waitForStableAnswer(page, answerLocator, config, timeoutMs) {
  const startedAt = Date.now();
  let previousText = "";
  let stableSince = 0;
  const settleMs = 1800;

  while (Date.now() - startedAt < timeoutMs) {
    const text = (await answerLocator.innerText().catch(() => "")).trim();
    if (!text || await isGenerating(page, config.generating)) {
      previousText = "";
      stableSince = 0;
    } else if (text !== previousText) {
      previousText = text;
      stableSince = Date.now();
    } else if (stableSince && Date.now() - stableSince >= settleMs) {
      return text;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("Assistant response did not finish before timeout; partial response discarded");
}

export function createOriginalSessionAdapter(provider, {
  approval,
  timeoutMs = 90000,
} = {}) {
  if (!Object.hasOwn(PROVIDERS, provider)) throw new TypeError("Unsupported provider");
  if (typeof approval !== "function") throw new TypeError("Per-message approval callback required");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 5000 || timeoutMs > 180000) {
    throw new RangeError("timeoutMs must be between 5000 and 180000");
  }
  const config = PROVIDERS[provider];
  return Object.freeze({
    provider,
    async ask(page, prompt, metadata = {}) {
      assertPage(page, provider);
      if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 10000) {
        throw new TypeError("Prompt must be 1-10000 characters");
      }
      const allowed = await approval({ provider, messageId: metadata.messageId ?? null, prompt });
      if (allowed !== true) throw new Error("Original-session message not approved");
      // Resolve selectors BEFORE touching the composer; fail closed on UI changes.
      const composer = await findVisible(page, config.composer);
      const send = await findVisible(page, config.send);
      const before = await page.locator(config.assistant.join(", ")).count();
      await composer.fill(prompt);
      if (!await send.isEnabled()) throw new Error("Provider send button unavailable");
      await send.click();
      // Require a NEW assistant message and wait for streaming to settle.
      const assistant = page.locator(config.assistant.join(", "));
      const response = assistant.nth(before);
      await response.waitFor({ state: "visible", timeout: timeoutMs });
      return waitForStableAnswer(page, response, config, timeoutMs);
    },
  });
}
