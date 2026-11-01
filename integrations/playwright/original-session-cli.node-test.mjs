import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import {
  bindAdapterToExactConversation,
  browserProcessEnvironment,
  conversationKey,
  isExactConversationPage,
  openExistingConversationPage,
  parseRunnerArgs,
  preparePrivateBrowserProfile,
  preview,
  runOriginalSessionBridge,
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
  assert.throws(() => parseRunnerArgs(["--provider", "unknown", "--conversation-url", CHATGPT_URL]), /Choose --provider chatgpt or --provider claude/);
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


test("pins all later group turns to the exact selected conversation", async () => {
  let currentUrl = CHATGPT_URL;
  let adapterCalls = 0;
  const wrapped = bindAdapterToExactConversation({
    provider: "chatgpt",
    async ask(_page, prompt) {
      adapterCalls += 1;
      return "reply: " + prompt;
    },
  }, "chatgpt", CHATGPT_URL);
  const page = { url: () => currentUrl };
  assert.equal(await wrapped.ask(page, "first message"), "reply: first message");
  currentUrl = "https://chatgpt.com/c/a-different-conversation";
  await assert.rejects(
    wrapped.ask(page, "second message"),
    error => error?.submissionState === "not_submitted" && /pinned original conversation changed/.test(error.message),
  );
  assert.equal(adapterCalls, 1, "the provider adapter must not be called after the tab changes threads");
});


test("declining startup consent never launches a browser or exposes the session handle", async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  output.isTTY = true;
  const writes = [];
  output.write = value => { writes.push(String(value)); return true; };
  let browserLaunches = 0;
  try {
    const result = await runOriginalSessionBridge({
      argv: ["--provider", "chatgpt", "--conversation-url", CHATGPT_URL],
      env: ENV,
      input,
      output,
      errorOutput: output,
      prompt: async () => false,
      playwright: {
        chromium: {
          async launchPersistentContext() {
            browserLaunches += 1;
            throw new Error("Browser must not launch without startup consent");
          },
        },
      },
    });
    assert.deepEqual(result, { status: "not_started", replies: 0 });
    assert.equal(browserLaunches, 0);
    assert.ok(!writes.join("").includes(ENV.RUB_MINDS_MCP_SESSION_HANDLE));
    assert.match(writes.join(""), /Not started/);
  } finally {
    input.destroy();
    output.destroy();
  }
});


test("passes only OS/runtime allowlisted variables to the Chromium child environment", () => {
  const source = {
    PATH: "safe-path",
    SystemRoot: "C:\\Windows",
    HOME: "/home/test",
    DISPLAY: ":0",
    PLAYWRIGHT_BROWSERS_PATH: "/cache/ms-playwright",
    RUB_MINDS_MCP_ENDPOINT: ENV.RUB_MINDS_MCP_ENDPOINT,
    RUB_MINDS_PARTICIPANT_ID: ENV.RUB_MINDS_PARTICIPANT_ID,
    RUB_MINDS_MCP_SESSION_HANDLE: ENV.RUB_MINDS_MCP_SESSION_HANDLE,
    OPENAI_API_KEY: "provider-secret",
    SUPABASE_SERVICE_ROLE_KEY: "database-secret",
    OTHER_SECRET: "unrelated-secret",
  };
  const browserEnv = browserProcessEnvironment(source);
  assert.equal(browserEnv.PATH, "safe-path");
  assert.equal(browserEnv.SystemRoot, "C:\\Windows");
  assert.equal(browserEnv.HOME, "/home/test");
  assert.equal(browserEnv.DISPLAY, ":0");
  assert.equal(browserEnv.PLAYWRIGHT_BROWSERS_PATH, "/cache/ms-playwright");
  assert.deepEqual(
    Object.keys(browserEnv).filter(key => /SECRET|KEY|RUB_MINDS|OPENAI/i.test(key)),
    [],
    "no application credentials or arbitrary shell variables may reach Chromium",
  );
  assert.equal(source.RUB_MINDS_MCP_SESSION_HANDLE, ENV.RUB_MINDS_MCP_SESSION_HANDLE,
    "filtering must not mutate the parent process environment");
});


test("renders untrusted group text without terminal control or bidi spoofing", () => {
  const rendered = preview("hello\r\t\u001b[2Jworld\u009b31m\u00adsoft\u200binvisible\u061cevil\u200ehidden\u2028separator\u2029paragraph\u202eoverride\u2060joiner\u2066isolate\u2069\ufeffbom\nnext");
  for (const forbidden of ["\r", "\t", "\u001b", "\u009b", "\u00ad", "\u200b", "\u061c", "\u200e", "\u2028", "\u2029", "\u202e", "\u2060", "\u2066", "\u2069", "\ufeff"]) {
    assert.equal(rendered.includes(forbidden), false, "must strip " + JSON.stringify(forbidden));
  }
  assert.ok(rendered.includes("\nnext"), "ordinary line breaks remain readable");
  assert.ok(rendered.startsWith("hello"));
});
