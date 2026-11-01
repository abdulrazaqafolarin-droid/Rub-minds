import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  conversationKey,
  isExactConversationPage,
  openExistingConversationPage,
  parseRunnerArgs,
  preparePrivateBrowserProfile,
  validateRunnerEnvironment,
} from "../../scripts/original-session-bridge.mjs";

const CHATGPT_URL = "https://chatgpt.com/c/conversation-123";
const CLAUDE_URL = "https://claude.ai/chat/conversation-456";
const ENV = {
  RUB_MINDS_MCP_ENDPOINT: "https://tzcuuynmviiuactafpld.supabase.co/functions/v1/rub-minds-mcp",
  RUB_MINDS_MCP_SESSION_HANDLE: "a".repeat(64),
  RUB_MINDS_PARTICIPANT_ID: "33333333-3333-4333-8333-333333333333",
};

test("parses only bounded provider, conversation and reply options", () => {
  assert.deepEqual(parseRunnerArgs([
    "--provider", "chatgpt", "--conversation-url", CHATGPT_URL, "--max-replies", "3",
  ]), {
    provider: "chatgpt",
    conversationUrl: CHATGPT_URL,
    maxReplies: 3,
  });
  assert.equal(parseRunnerArgs(["--provider", "claude", "--conversation-url", CLAUDE_URL]).maxReplies, 5);
  assert.throws(() => parseRunnerArgs(["--provider", "unknown", "--conversation-url", CHATGPT_URL]), /chatgpt or claude/);
  assert.throws(() => parseRunnerArgs(["--provider", "chatgpt"]), /conversation-url/);
  assert.throws(() => parseRunnerArgs(["--provider", "chatgpt", "--conversation-url", CHATGPT_URL, "--max-replies", "21"]), /1 to 20/);
  assert.throws(() => parseRunnerArgs(["--provider", "chatgpt", "--provider", "claude", "--conversation-url", CHATGPT_URL]), /duplicate/);
  assert.throws(() => parseRunnerArgs(["--provider", "chatgpt", "--conversation-url", "https://evil.example/c/123"]), /existing chatgpt conversation/);
  assert.throws(() => parseRunnerArgs(["--provider", "chatgpt", "--conversation-url", CHATGPT_URL + "?token=secret"]), /existing chatgpt conversation/);
});

test("requires a clean HTTPS MCP endpoint and scoped session identity", () => {
  const config = validateRunnerEnvironment(ENV, "chatgpt");
  assert.equal(new URL(config.endpoint).protocol, "https:");
  assert.match(config.profileDirectory, /original-session-profiles[\\/]chatgpt$/);
  assert.equal(validateRunnerEnvironment(ENV, "claude").profileDirectory.endsWith("claude"), true);
  for (const invalid of [
    { ...ENV, RUB_MINDS_MCP_ENDPOINT: "http://staging-example.supabase.co/functions/v1/rub-minds-mcp" },
    { ...ENV, RUB_MINDS_MCP_ENDPOINT: "https://user:pass@staging-example.supabase.co/functions/v1/rub-minds-mcp" },
    { ...ENV, RUB_MINDS_MCP_ENDPOINT: "https://tzcuuynmviiuactafpld.supabase.co/functions/v1/rub-minds-mcp?token=x" },
    { ...ENV, RUB_MINDS_MCP_ENDPOINT: "https://staging-example.supabase.co/functions/v1/other" },
    { ...ENV, RUB_MINDS_MCP_ENDPOINT: "https://zucaeevlbwhcvjwbhwmq.supabase.co/functions/v1/rub-minds-mcp" },
    { ...ENV, RUB_MINDS_MCP_SESSION_HANDLE: "short" },
    { ...ENV, RUB_MINDS_PARTICIPANT_ID: "not-a-uuid" },
  ]) {
    assert.throws(() => validateRunnerEnvironment(invalid, "chatgpt"));
  }
});

test("provider conversation URLs are exact HTTPS thread URLs without credentials or query secrets", () => {
  assert.equal(conversationKey("chatgpt", CHATGPT_URL), CHATGPT_URL);
  assert.equal(conversationKey("claude", CLAUDE_URL), CLAUDE_URL);
  assert.throws(() => conversationKey("chatgpt", "http://chatgpt.com/c/123"), /existing chatgpt conversation/);
  assert.throws(() => conversationKey("claude", "https://chatgpt.com/c/123"), /existing claude conversation/);
  assert.throws(() => conversationKey("chatgpt", "https://chatgpt.com/c/123?access_token=secret"), /existing chatgpt conversation/);
  assert.throws(() => conversationKey("chatgpt", "https://user:pass@chatgpt.com/c/123"), /existing chatgpt conversation/);
});

test("creates a dedicated persistent browser profile directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "rub-minds-profile-test-"));
  const directory = join(root, "profile");
  try {
    assert.equal(await preparePrivateBrowserProfile(directory), directory);
    assert.equal((await stat(directory)).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selects only the exact already-open provider conversation and rejects duplicates", async () => {
  const page = url => ({
    isClosed: () => false,
    url: () => url,
    async goto(next) { this.current = next; },
  });
  const matching = page(CHATGPT_URL + "?view=temporary");
  // Query/hash are ignored when matching the provider's origin + thread path.
  const context = {
    pages: () => [page("https://example.com/"), matching],
    async newPage() { throw new Error("No new page should be needed"); },
  };
  assert.equal(await openExistingConversationPage(context, "chatgpt", CHATGPT_URL), matching);
  assert.equal(isExactConversationPage(matching, "chatgpt", CHATGPT_URL), true);
  const duplicateContext = { ...context, pages: () => [page(CHATGPT_URL), page(CHATGPT_URL)] };
  await assert.rejects(() => openExistingConversationPage(duplicateContext, "chatgpt", CHATGPT_URL), /More than one open tab/);
});

test("opens only the exact supplied thread and lets a human finish first-run sign-in", async () => {
  const blank = {
    current: "about:blank",
    isClosed: () => false,
    url() { return this.current; },
    async goto(url) { this.navigation = url; this.current = "https://chatgpt.com/auth/login"; },
  };
  const context = {
    pages: () => [blank],
    async newPage() { throw new Error("The existing blank tab should be reused"); },
  };
  const page = await openExistingConversationPage(context, "chatgpt", CHATGPT_URL);
  assert.equal(blank.navigation, CHATGPT_URL);
  assert.equal(page, blank);
  assert.equal(isExactConversationPage(page, "chatgpt", CHATGPT_URL), false);
  // After manual sign-in/navigation, exact thread verification succeeds.
  blank.current = CHATGPT_URL;
  assert.equal(isExactConversationPage(page, "chatgpt", CHATGPT_URL), true);
});

test("creates a new tab when no blank or exact conversation tab exists", async () => {
  const other = {
    isClosed: () => false,
    url: () => "https://example.com/",
  };
  const created = {
    current: "about:blank",
    isClosed: () => false,
    url() { return this.current; },
    async goto(url) { this.current = url; },
  };
  const context = {
    pages: () => [other],
    async newPage() { return created; },
  };
  assert.equal(await openExistingConversationPage(context, "claude", CLAUDE_URL), created);
  assert.equal(created.current, CLAUDE_URL);
  assert.equal(isExactConversationPage(created, "claude", CLAUDE_URL), true);
});
