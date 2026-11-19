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
  createPrivateJoinedSessionStore,
  createPrivateTaskStateStore,
  isExactConversationPage,
  openExistingConversationPage,
  parseRunnerArgs,
  parseStagingInviteToken,
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

function makeMemoryStateStore() {
  let value = null;
  return {
    async prepare() {},
    async load() { return structuredClone(value); },
    async save(next) { value = structuredClone(next); },
  };
}

function makeRunnerStateDependencies({ participantId = ENV.RUB_MINDS_PARTICIPANT_ID, roomId = "550e8400-e29b-41d4-a716-446655440000" } = {}) {
  return {
    createTaskStateStore: () => makeMemoryStateStore(),
    createJoinedSessionStore: () => ({
      async prepare() {},
      async load() { return null; },
      async save() {},
      async clear() {},
    }),
    createSessionTransport: () => ({
      async readGroupContext() {
        return {
          room: { id: "550e8400-e29b-41d4-a716-446655440000" },
          self: { participant_id: ENV.RUB_MINDS_PARTICIPANT_ID },
        };
      },
      async leaveGroup() { return { left: true }; },
    }),
  };
}


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

test("parses only opaque HTTPS Staging invite tokens without logging or fetching the pasted URL", () => {
  const token = "b".repeat(64);
  assert.equal(parseStagingInviteToken("https://rub-minds.vercel.app/?invite=" + token), token);
  assert.equal(parseStagingInviteToken("https://rub-minds.vercel.app/invite=" + token), token);
  assert.throws(() => parseStagingInviteToken("http://rub-minds.vercel.app/?invite=" + token), /HTTPS/);
  assert.throws(() => parseStagingInviteToken("https://user:pass@rub-minds.vercel.app/?invite=" + token), /credentials/);
  assert.throws(() => parseStagingInviteToken("https://rub-minds.vercel.app/?invite=" + token + "#secret"), /fragment/);
  assert.throws(() => parseStagingInviteToken("https://rub-minds.vercel.app/?invite=short"), /64-character/);
});

test("permits an explicit Staging invitation join when no prejoined session is configured", () => {
  const config = validateRunnerEnvironment({
    RUB_MINDS_MCP_ENDPOINT: ENV.RUB_MINDS_MCP_ENDPOINT,
  }, "chatgpt");
  assert.equal(config.joinRequired, true);
  assert.equal(config.sessionHandle, null);
  assert.equal(config.participantId, null);
  assert.throws(() => validateRunnerEnvironment({
    RUB_MINDS_MCP_ENDPOINT: ENV.RUB_MINDS_MCP_ENDPOINT,
    RUB_MINDS_MCP_SESSION_HANDLE: "a".repeat(64),
  }, "chatgpt"), /Set both/);
});

test("private task state store survives restart but keeps results separate from joined-session capabilities", async () => {
  const root = await mkdtemp(join(tmpdir(), "rub-minds-task-state-"));
  const participantId = ENV.RUB_MINDS_PARTICIPANT_ID;
  try {
    const store = createPrivateTaskStateStore({ provider: "chatgpt", participantId, baseDirectory: root });
    await store.prepare();
    assert.equal(await store.load(), null);
    const pending = {
      schema: 1,
      phase: "result_ready",
      participantId,
      taskId: "550e8400-e29b-41d4-a716-446655440000",
      taskVersion: 5,
      submissionKey: "650e8400-e29b-41d4-a716-446655440000",
      result: "Private pending result",
    };
    await store.save(pending);
    assert.deepEqual(await store.load(), pending);
    const fileStats = await stat(store.path);
    assert.equal(fileStats.isFile(), true);
    if (process.platform !== "win32") {
      assert.equal(fileStats.mode & 0o777, 0o600);
    }
    await store.save(null);
    assert.equal(await store.load(), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private joined-session store keys by provider and exact conversation and stores no invite token", async () => {
  const root = await mkdtemp(join(tmpdir(), "rub-minds-join-state-"));
  try {
    const store = createPrivateJoinedSessionStore({
      provider: "chatgpt",
      conversationUrl: CHATGPT_URL,
      baseDirectory: root,
    });
    const second = createPrivateJoinedSessionStore({
      provider: "chatgpt",
      conversationUrl: "https://chatgpt.com/c/a-different-conversation",
      baseDirectory: root,
    });
    const inviteToken = "b".repeat(64);
    const binding = {
      sessionHandle: "c".repeat(64),
      participantId: ENV.RUB_MINDS_PARTICIPANT_ID,
      roomId: "550e8400-e29b-41d4-a716-446655440000",
      expiresAt: "2026-11-20T00:00:00.000Z",
    };
    await store.prepare();
    assert.equal(await store.load(), null);
    await store.save(binding);
    assert.deepEqual(await store.load(), binding);
    assert.notEqual(store.path, second.path);
    const diskText = await (await import("node:fs/promises")).readFile(store.path, "utf8");
    assert.equal(diskText.includes(inviteToken), false);
    assert.equal(diskText.includes("invite_token"), false);
    const fileStats = await stat(store.path);
    if (process.platform !== "win32") assert.equal(fileStats.mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
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
      ...makeRunnerStateDependencies(),
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


function makeTtyStream() {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.setRawMode = () => {};
  return stream;
}

function makeRunnerContext(page, stats) {
  return {
    pages: () => [page],
    async newPage() {
      throw new Error("An exact existing conversation page should be reused");
    },
    async close() {
      stats.contextClosed += 1;
    },
  };
}

test("local runner starts with consent, approves one new group message, and closes only its owned context", async () => {
  const input = makeTtyStream();
  const output = makeTtyStream();
  const writes = [];
  output.write = value => { writes.push(String(value)); return true; };
  const stats = { launches: 0, contextClosed: 0, runtimeStopped: 0, providerInteractions: 0 };
  const page = { isClosed: () => false, url: () => CHATGPT_URL };
  const context = makeRunnerContext(page, stats);
  const approvals = [];

  try {
    const result = await runOriginalSessionBridge({
      argv: ["--provider", "chatgpt", "--conversation-url", CHATGPT_URL, "--max-replies", "2"],
      env: { ...ENV, PATH: "safe-path", OPENAI_API_KEY: "must-not-reach-browser" },
      input,
      output,
      errorOutput: output,
      ...makeRunnerStateDependencies(),
      playwright: {
        chromium: {
          async launchPersistentContext(profileDirectory, options) {
            stats.launches += 1;
            assert.equal(profileDirectory.endsWith("chatgpt"), true);
            assert.equal(options.headless, false);
            assert.equal(options.env.PATH, "safe-path");
            assert.equal(Object.hasOwn(options.env, "OPENAI_API_KEY"), false);
            assert.equal(Object.hasOwn(options.env, "RUB_MINDS_MCP_SESSION_HANDLE"), false);
            return context;
          },
        },
      },
      prepareProfile: async value => value,
      prompt: async (_rl, message, expected) => {
        approvals.push({ message, expected });
        return true;
      },
      createAdapter: (_provider, { approval }) => ({
        async ask(_page, body, metadata) {
          const approved = await approval({ ...metadata, prompt: body });
          assert.equal(approved, true);
          stats.providerInteractions += 1;
          return "provider answer";
        },
      }),
      createRuntime: options => ({
        async run({ approved }) {
          assert.equal(approved, true);
          const answer = await options.adapter.ask(options.page, "share this safely", {
            messageId: "message-1",
            senderName: "Human collaborator",
            senderKind: "human",
          });
          assert.equal(answer, "provider answer");
          return { status: "limit_reached", replies: 1 };
        },
        stop() {
          stats.runtimeStopped += 1;
        },
      }),
    });

    assert.deepEqual(result, { status: "limit_reached", replies: 1 });
    assert.deepEqual(approvals.map(item => item.expected), ["START", "SEND"]);
    assert.equal(stats.launches, 1);
    assert.equal(stats.providerInteractions, 1);
    assert.equal(stats.runtimeStopped, 1);
    assert.equal(stats.contextClosed, 1);
    assert.ok(!writes.join("").includes(ENV.RUB_MINDS_MCP_SESSION_HANDLE));
  } finally {
    input.destroy();
    output.destroy();
  }
});

test("local runner explicitly redeems a Staging invite and binds the returned AI session to the exact browser conversation", async () => {
  const input = makeTtyStream();
  const output = makeTtyStream();
  const writes = [];
  output.write = value => { writes.push(String(value)); return true; };
  const inviteToken = "b".repeat(64);
  const sessionHandle = "c".repeat(64);
  const participantId = "650e8400-e29b-41d4-a716-446655440000";
  const roomId = "550e8400-e29b-41d4-a716-446655440000";
  const inviteUrl = "https://rub-minds.vercel.app/?invite=" + inviteToken;
  const env = { RUB_MINDS_MCP_ENDPOINT: ENV.RUB_MINDS_MCP_ENDPOINT };
  const stats = { contextClosed: 0, runtimeStopped: 0, providerInteractions: 0 };
  const page = { isClosed: () => false, url: () => CHATGPT_URL };
  const context = makeRunnerContext(page, stats);
  const approvals = [];
  let joinedInput;
  let runtimeOptions;

  try {
    const result = await runOriginalSessionBridge({
      argv: ["--provider", "chatgpt", "--conversation-url", CHATGPT_URL],
      env,
      input,
      output,
      errorOutput: output,
      ...makeRunnerStateDependencies(),
      playwright: {
        chromium: {
          async launchPersistentContext(_profileDirectory, options) {
            assert.equal(options.headless, false);
            assert.equal(Object.hasOwn(options.env, "RUB_MINDS_MCP_SESSION_HANDLE"), false);
            assert.equal(Object.hasOwn(options.env, "RUB_MINDS_MCP_ENDPOINT"), false);
            return context;
          },
        },
      },
      prepareProfile: async value => value,
      readInput: async (_rl, message) => {
        assert.match(message, /invitation URL/);
        return inviteUrl;
      },
      prompt: async (_rl, message, expected) => {
        approvals.push({ message, expected });
        return true;
      },
      joinInvite: async options => {
        joinedInput = options;
        return { joined: true, sessionHandle, roomId, participantId };
      },
      createAdapter: (_provider, { approval }) => ({
        async ask(_page, body, metadata) {
          const approved = await approval({ ...metadata, prompt: body });
          assert.equal(approved, true);
          stats.providerInteractions += 1;
          return "provider answer";
        },
      }),
      createRuntime: options => {
        runtimeOptions = options;
        return {
          async run({ approved }) {
            assert.equal(approved, true);
            const answer = await options.adapter.ask(options.page, "Staging group message", {
              messageId: "message-join-1",
              senderName: "Human collaborator",
              senderKind: "human",
            });
            assert.equal(answer, "provider answer");
            return { status: "limit_reached", replies: 1 };
          },
          stop() { stats.runtimeStopped += 1; },
        };
      },
    });

    assert.deepEqual(result, { status: "limit_reached", replies: 1 });
    assert.deepEqual(approvals.map(item => item.expected), ["START", "JOIN", "SEND"]);
    assert.equal(joinedInput.endpoint, ENV.RUB_MINDS_MCP_ENDPOINT);
    assert.equal(joinedInput.inviteToken, inviteToken);
    assert.equal(joinedInput.agentLabel, "ChatGPT original session");
    assert.equal(joinedInput.signal instanceof AbortSignal, true);
    assert.equal(runtimeOptions.sessionHandle, sessionHandle);
    assert.equal(runtimeOptions.participantId, participantId);
    assert.equal(stats.providerInteractions, 1);
    assert.equal(stats.contextClosed, 1);
    assert.ok(!writes.join("").includes(inviteToken), "invite token must not be printed");
    assert.ok(!writes.join("").includes(sessionHandle), "session handle must not be printed");
  } finally {
    input.destroy();
    output.destroy();
  }
});

test("declining explicit Staging invitation redemption stops before MCP join or runtime creation", async () => {
  const input = makeTtyStream();
  const output = makeTtyStream();
  output.write = () => true;
  const stats = { contextClosed: 0, runtimeStopped: 0, providerInteractions: 0 };
  const context = makeRunnerContext({ isClosed: () => false, url: () => CHATGPT_URL }, stats);
  let joinCalls = 0;
  let runtimeCalls = 0;
  try {
    const result = await runOriginalSessionBridge({
      argv: ["--provider", "chatgpt", "--conversation-url", CHATGPT_URL],
      env: { RUB_MINDS_MCP_ENDPOINT: ENV.RUB_MINDS_MCP_ENDPOINT },
      input,
      output,
      errorOutput: output,
      ...makeRunnerStateDependencies(),
      playwright: { chromium: { async launchPersistentContext() { return context; } } },
      prepareProfile: async value => value,
      readInput: async () => "https://rub-minds.vercel.app/?invite=" + "d".repeat(64),
      prompt: async (_rl, _message, expected) => expected !== "JOIN",
      joinInvite: async () => { joinCalls++; throw new Error("join must not execute"); },
      createRuntime: () => { runtimeCalls++; throw new Error("runtime must not start"); },
    });
    assert.deepEqual(result, { status: "not_started", replies: 0 });
    assert.equal(joinCalls, 0);
    assert.equal(runtimeCalls, 0);
    assert.equal(stats.contextClosed, 1);
  } finally {
    input.destroy();
    output.destroy();
  }
});

test("declining a per-message SEND approval prevents provider interaction and still closes the owned context", async () => {
  const input = makeTtyStream();
  const output = makeTtyStream();
  output.write = () => true;
  const stats = { contextClosed: 0, runtimeStopped: 0, providerInteractions: 0 };
  const page = { isClosed: () => false, url: () => CHATGPT_URL };
  const context = makeRunnerContext(page, stats);

  try {
    await assert.rejects(
      runOriginalSessionBridge({
        argv: ["--provider", "chatgpt", "--conversation-url", CHATGPT_URL],
        env: ENV,
        input,
        output,
        errorOutput: output,
      ...makeRunnerStateDependencies(),
        playwright: {
          chromium: {
            async launchPersistentContext() { return context; },
          },
        },
        prepareProfile: async value => value,
        prompt: async (_rl, _message, expected) => expected === "START",
        createAdapter: (_provider, { approval }) => ({
          async ask(_page, body, metadata) {
            const approved = await approval({ ...metadata, prompt: body });
            if (!approved) {
              const error = new Error("approval denied");
              error.submissionState = "not_submitted";
              throw error;
            }
            stats.providerInteractions += 1;
            return "must not send";
          },
        }),
        createRuntime: options => ({
          async run() {
            return options.adapter.ask(options.page, "private group request", {
              messageId: "message-2",
              senderName: "Human collaborator",
              senderKind: "human",
            });
          },
          stop() { stats.runtimeStopped += 1; },
        }),
      }),
      /approval denied/,
    );
    assert.equal(stats.providerInteractions, 0);
    assert.equal(stats.runtimeStopped, 1);
    assert.equal(stats.contextClosed, 1);
  } finally {
    input.destroy();
    output.destroy();
  }
});


test("Ctrl+C while awaiting START returns stopped without opening a browser", async () => {
  const input = makeTtyStream();
  const output = makeTtyStream();
  output.write = () => true;
  let browserLaunches = 0;
  try {
    const result = await runOriginalSessionBridge({
      argv: ["--provider", "chatgpt", "--conversation-url", CHATGPT_URL],
      env: ENV,
      input,
      output,
      errorOutput: output,
      ...makeRunnerStateDependencies(),
      prompt: async () => {
        process.emit("SIGINT");
        const error = new Error("interactive prompt aborted");
        error.name = "AbortError";
        throw error;
      },
      playwright: {
        chromium: {
          async launchPersistentContext() {
            browserLaunches += 1;
            throw new Error("Browser must not launch after cancellation");
          },
        },
      },
    });
    assert.deepEqual(result, { status: "stopped", replies: 0 });
    assert.equal(browserLaunches, 0);
  } finally {
    input.destroy();
    output.destroy();
  }
});

test("Ctrl+C while awaiting SEND stops without provider interaction and closes the owned browser context", async () => {
  const input = makeTtyStream();
  const output = makeTtyStream();
  output.write = () => true;
  const stats = { contextClosed: 0, runtimeStopped: 0, providerInteractions: 0 };
  const page = { isClosed: () => false, url: () => CHATGPT_URL };
  const context = makeRunnerContext(page, stats);

  try {
    const result = await runOriginalSessionBridge({
      argv: ["--provider", "chatgpt", "--conversation-url", CHATGPT_URL],
      env: ENV,
      input,
      output,
      errorOutput: output,
      ...makeRunnerStateDependencies(),
      playwright: {
        chromium: {
          async launchPersistentContext() { return context; },
        },
      },
      prepareProfile: async value => value,
      prompt: async (_rl, _message, expected) => {
        if (expected === "START") return true;
        process.emit("SIGINT");
        const error = new Error("per-message approval prompt aborted");
        error.name = "AbortError";
        throw error;
      },
      createAdapter: (_provider, { approval }) => ({
        async ask(_page, body, metadata) {
          await approval({ ...metadata, prompt: body });
          stats.providerInteractions += 1;
          return "must never be reached";
        },
      }),
      createRuntime: options => ({
        async run({ approved, signal }) {
          assert.equal(approved, true);
          await options.adapter.ask(options.page, "one group message", {
            messageId: "message-cancelled",
            senderName: "Human collaborator",
            senderKind: "human",
            signal,
          });
          return { status: "ok", replies: 1 };
        },
        stop() { stats.runtimeStopped += 1; },
      }),
    });

    assert.deepEqual(result, { status: "stopped", replies: 0 });
    assert.equal(stats.providerInteractions, 0);
    assert.equal(stats.runtimeStopped, 1);
    assert.equal(stats.contextClosed, 1);
  } finally {
    input.destroy();
    output.destroy();
  }
});
