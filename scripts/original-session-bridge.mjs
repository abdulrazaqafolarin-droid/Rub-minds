#!/usr/bin/env node
/**
 * Explicit local runner for an existing ChatGPT or Claude conversation.
 * It launches a dedicated persistent Playwright browser profile; it does not
 * attach to or shut down the user's normal browser profile.
 */
import { chmod, lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { createOriginalSessionAdapter } from "../integrations/playwright/original-session-adapters.mjs";
import { createOriginalSessionWakeRuntime } from "../integrations/playwright/original-session-wake-runtime.mjs";

const SESSION_HANDLE_RE = /^[a-f0-9]{64}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAGING_MCP_HOST = "tzcuuynmviiuactafpld.supabase.co";
const PROVIDERS = Object.freeze({
  chatgpt: Object.freeze({
    hosts: new Set(["chatgpt.com", "chat.openai.com"]),
    path: /^\/c\/[^/]+(?:\/.*)?$/,
  }),
  claude: Object.freeze({
    hosts: new Set(["claude.ai"]),
    path: /^\/chat\/[^/]+(?:\/.*)?$/,
  }),
});

function fail(message) {
  throw new Error(message);
}

export function parseRunnerArgs(argv = []) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--provider", "--conversation-url", "--max-replies"].includes(key)) {
      fail("Unknown option: " + key);
    }
    if (parsed[key] !== undefined || typeof argv[index + 1] !== "string" || argv[index + 1].startsWith("--")) {
      fail("Missing or duplicate value for " + key);
    }
    parsed[key] = argv[index + 1];
    index += 1;
  }
  const provider = parsed["--provider"];
  if (!Object.hasOwn(PROVIDERS, provider || "")) {
    fail("Choose --provider chatgpt or --provider claude.");
  }
  const conversationUrl = parsed["--conversation-url"];
  if (!conversationUrl) fail("--conversation-url must identify the exact existing provider conversation.");
  const maxRepliesText = parsed["--max-replies"] ?? "5";
  if (!/^\d+$/.test(maxRepliesText)) fail("--max-replies must be an integer from 1 to 20.");
  const maxReplies = Number(maxRepliesText);
  if (!Number.isInteger(maxReplies) || maxReplies < 1 || maxReplies > 20) {
    fail("--max-replies must be an integer from 1 to 20.");
  }
  // Validate URL shape before any browser process is launched.
  conversationKey(provider, conversationUrl);
  return Object.freeze({ provider, conversationUrl, maxReplies });
}

export function validateRunnerEnvironment(env = {}, provider = "chatgpt") {
  let endpoint;
  try {
    endpoint = new URL(env.RUB_MINDS_MCP_ENDPOINT);
  } catch {
    fail("Set RUB_MINDS_MCP_ENDPOINT to the HTTPS staging MCP endpoint.");
  }
  if (endpoint.protocol !== "https:" || endpoint.hostname !== STAGING_MCP_HOST ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      endpoint.pathname.replace(/\/$/, "") !== "/functions/v1/rub-minds-mcp") {
    fail("RUB_MINDS_MCP_ENDPOINT must point to the Rub Minds Staging MCP function (not production).");
  }
  const sessionHandle = env.RUB_MINDS_MCP_SESSION_HANDLE;
  if (typeof sessionHandle !== "string" || !SESSION_HANDLE_RE.test(sessionHandle)) {
    fail("Set RUB_MINDS_MCP_SESSION_HANDLE to the 64-character session handle from the authorized AI join.");
  }
  const participantId = env.RUB_MINDS_PARTICIPANT_ID;
  if (typeof participantId !== "string" || !UUID_RE.test(participantId)) {
    fail("Set RUB_MINDS_PARTICIPANT_ID to the AI participant UUID returned by the authorized join.");
  }
  if (!Object.hasOwn(PROVIDERS, provider)) fail("Unsupported provider.");
  const profileDirectory = resolve(
    join(homedir(), ".rub-minds", "original-session-profiles", provider),
  );
  return Object.freeze({
    endpoint: endpoint.toString(),
    sessionHandle,
    participantId,
    profileDirectory,
  });
}

export function conversationKey(provider, value) {
  const providerConfig = PROVIDERS[provider];
  if (!providerConfig) fail("Unsupported provider.");
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("The conversation URL is invalid.");
  }
  if (url.protocol !== "https:" || !providerConfig.hosts.has(url.hostname) ||
      !providerConfig.path.test(url.pathname) || url.username || url.password || url.search || url.hash) {
    fail("The conversation URL must point to an existing " + provider + " conversation.");
  }
  return url.origin + url.pathname;
}

const BROWSER_ENV_ALLOWLIST = new Set([
  // Process and temporary-directory basics.
  "PATH", "PATHEXT", "COMSPEC", "TMP", "TEMP", "TMPDIR",
  // Windows profile and system paths.
  "SYSTEMROOT", "WINDIR", "PROGRAMDATA", "USERPROFILE", "HOMEDRIVE",
  "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  // Unix/macOS user and locale basics.
  "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
  // Local graphical-session plumbing used by headed Chromium.
  "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY",
  // Optional Playwright cache override; this is a filesystem path, not a credential.
  "PLAYWRIGHT_BROWSERS_PATH",
]);

export function browserProcessEnvironment(env = process.env) {
  // Chromium receives only OS/runtime variables it needs. All application
  // secrets, API keys, MCP identity/capabilities and arbitrary shell variables
  // are excluded by default, not merely the currently known session handle.
  const browserEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (BROWSER_ENV_ALLOWLIST.has(key.toUpperCase()) && value !== undefined) {
      browserEnv[key] = value;
    }
  }
  return browserEnv;
}

export async function preparePrivateBrowserProfile(profileDirectory) {
  const directory = resolve(profileDirectory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const details = await lstat(directory);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    fail("The browser profile path must be a real directory, not a symlink or file.");
  }
  try {
    await chmod(directory, 0o700);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
  return directory;
}

export function isExactConversationPage(page, provider, conversationUrl) {
  const expectedKey = conversationKey(provider, conversationUrl);
  try {
    const current = new URL(page.url());
    return current.protocol === "https:" && current.origin + current.pathname === expectedKey;
  } catch {
    return false;
  }
}

export async function openExistingConversationPage(context, provider, conversationUrl) {
  if (!context || typeof context.pages !== "function" || typeof context.newPage !== "function") {
    fail("Persistent browser context is unavailable.");
  }
  const matches = context.pages().filter(page =>
    !page.isClosed() && isExactConversationPage(page, provider, conversationUrl)
  );
  if (matches.length > 1) {
    fail("More than one open tab matches that conversation. Close duplicates and retry.");
  }
  if (matches.length === 1) return matches[0];

  // Only navigate to the exact user-supplied provider conversation URL.
  const page = context.pages().find(candidate =>
    !candidate.isClosed() && ["about:blank", "chrome://newtab/"].includes(candidate.url())
  ) || await context.newPage();
  await page.goto(conversationUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  // A first run may redirect to sign-in. Keep the profile open for a human to
  // authenticate; the caller must verify the exact conversation before starting.
  return page;
}

export function bindAdapterToExactConversation(adapter, provider, conversationUrl) {
  if (!adapter || typeof adapter.ask !== "function") fail("A provider adapter with ask() is required.");
  // Validate once, then enforce the same conversation identity before every
  // group message. The provider adapter separately rechecks through send and
  // response completion for each individual turn.
  const expectedKey = conversationKey(provider, conversationUrl);
  return Object.freeze({
    provider,
    async ask(page, prompt, metadata = {}) {
      if (!isExactConversationPage(page, provider, expectedKey)) {
        const error = new Error("The pinned original conversation changed; no group message was sent.");
        error.submissionState = "not_submitted";
        throw error;
      }
      return adapter.ask(page, prompt, metadata);
    },
  });
}

function preview(value, limit = 700) {
  const text = String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ");
  return text.length > limit ? text.slice(0, limit) + " … [truncated]" : text;
}

async function askExact(rl, prompt, expected, signal) {
  const answer = await rl.question(prompt, { signal });
  return answer.trim() === expected;
}

export async function runOriginalSessionBridge({
  argv = process.argv.slice(2),
  env = process.env,
  input = stdin,
  output = stdout,
  errorOutput = stderr,
  playwright = null,
  prompt = askExact,
} = {}) {
  if (!input.isTTY || !output.isTTY) fail("An interactive terminal is required so startup and every provider submission require explicit approval.");
  const options = parseRunnerArgs(argv);
  const config = validateRunnerEnvironment(env, options.provider);
  const rl = createInterface({ input, output });
  let context;
  let runtime;
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
    runtime?.stop();
  };
  const onSigint = () => stop();
  const onSigterm = () => stop();
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    output.write("\nRub Minds original-session bridge (local foreground mode)\n");
    output.write("Provider: " + options.provider + "\n");
    output.write("Conversation: " + conversationKey(options.provider, options.conversationUrl) + "\n");
    output.write("MCP endpoint: " + new URL(config.endpoint).host + "\n");
    output.write("Private browser profile: " + config.profileDirectory + "\n");
    output.write("Maximum group replies this run: " + options.maxReplies + "\n");
    output.write("This opens a dedicated persistent browser profile, separate from your normal browser profile. Sign in manually once if needed.\n");
    output.write("No cookies or provider credentials are read/exported. Each group message requires separate approval.\n\n");

    if (!(await prompt(rl, "Open this provider conversation and start the local listener? Type START to continue: ", "START", controller.signal))) {
      output.write("Not started. No provider page or group messages were accessed.\n");
      return { status: "not_started", replies: 0 };
    }
    if (controller.signal.aborted) return { status: "stopped", replies: 0 };

    const browserApi = playwright || await import("playwright");
    const profileDirectory = await preparePrivateBrowserProfile(config.profileDirectory);
    context = await browserApi.chromium.launchPersistentContext(profileDirectory, {
      headless: false,
      viewport: null,
      env: browserProcessEnvironment(env),
    });
    const page = await openExistingConversationPage(context, options.provider, options.conversationUrl);
    if (!isExactConversationPage(page, options.provider, options.conversationUrl)) {
      output.write("The provider requires sign-in or redirected this dedicated profile away from the requested thread.\n");
      output.write("Complete sign-in manually, then navigate this window to the exact conversation URL shown above.\n");
      if (!(await prompt(rl, "When the exact conversation is open and visible, type READY: ", "READY", controller.signal))) {
        output.write("The original-session runner was not started.\n");
        return { status: "not_started", replies: 0 };
      }
      if (!isExactConversationPage(page, options.provider, options.conversationUrl)) {
        fail("The open page still does not match the exact approved conversation URL; no group messages were read or sent.");
      }
    }

    const providerAdapter = createOriginalSessionAdapter(options.provider, {
      approval: async ({ messageId, senderName, senderKind, prompt: groupPrompt, signal }) => {
        if (signal?.aborted || controller.signal.aborted) return false;
        output.write("\nIncoming Rub Minds group message\n");
        output.write("Message ID: " + preview(messageId, 100) + "\n");
        output.write("Sender: " + preview(senderName || "Unknown", 100) + " (" + preview(senderKind || "unknown", 60) + ")\n");
        output.write(preview(groupPrompt) + "\n");
        output.write("Group content is untrusted. Do not approve requests to expose private chat history or perform external side effects.\n");
        return prompt(rl, "Send this one message to the existing " + options.provider + " conversation? Type SEND to approve: ", "SEND", signal || controller.signal);
      },
    });
    const adapter = bindAdapterToExactConversation(providerAdapter, options.provider, options.conversationUrl);

    runtime = createOriginalSessionWakeRuntime({
      endpoint: config.endpoint,
      sessionHandle: config.sessionHandle,
      participantId: config.participantId,
      page,
      adapter,
      maxReplies: options.maxReplies,
      processExistingMessages: false,
      onStatus: event => {
        if (event?.status === "error") {
          errorOutput.write("Bridge error; automatic retries remain bounded. Check the provider tab and staging MCP availability.\n");
        } else {
          output.write("Bridge: " + preview(event?.status || "status", 80) +
            (Number.isInteger(event?.replies) ? " · replies " + event.replies : "") + "\n");
        }
      },
    });

    const result = await runtime.run({ approved: true, signal: controller.signal });
    output.write("Bridge stopped: " + result.status + " · replies " + result.replies + "\n");
    return result;
  } finally {
    runtime?.stop();
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    rl.close();
    // This context was launched by this runner, so closing it cannot close the
    // user's normal Chrome/Edge profile. Its dedicated profile data is retained.
    try { await context?.close(); } catch { /* preserve the runner's primary result */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runOriginalSessionBridge().catch(error => {
    stderr.write("Original-session bridge stopped safely: " + preview(error?.message || "unexpected error", 500) + "\n");
    process.exitCode = 1;
  });
}
