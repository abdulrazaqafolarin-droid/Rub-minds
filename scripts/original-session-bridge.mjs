#!/usr/bin/env node
/**
 * Explicitly attach the original-session bridge to one already-open provider tab.
 * This is a local, foreground runner; it does not launch a browser, persist secrets,
 * or run when the user's device is offline.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { createOriginalSessionAdapter } from "../integrations/playwright/original-session-adapters.mjs";
import { createOriginalSessionWakeRuntime } from "../integrations/playwright/original-session-wake-runtime.mjs";

const SESSION_HANDLE_RE = /^[a-f0-9]{64}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
  return Object.freeze({ provider, conversationUrl, maxReplies });
}

export function validateRunnerEnvironment(env = {}) {
  const endpointValue = env.RUB_MINDS_MCP_ENDPOINT;
  let endpoint;
  try {
    endpoint = new URL(endpointValue);
  } catch {
    fail("Set RUB_MINDS_MCP_ENDPOINT to the HTTPS staging MCP endpoint.");
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || !endpoint.pathname.replace(/\/$/, "").endsWith("/functions/v1/rub-minds-mcp")) {
    fail("RUB_MINDS_MCP_ENDPOINT must be a clean HTTPS Supabase MCP function URL (no credentials, query or fragment).");
  }

  const sessionHandle = env.RUB_MINDS_MCP_SESSION_HANDLE;
  if (typeof sessionHandle !== "string" || !SESSION_HANDLE_RE.test(sessionHandle)) {
    fail("Set RUB_MINDS_MCP_SESSION_HANDLE to the 64-character session handle from the authorized AI join.");
  }
  const participantId = env.RUB_MINDS_PARTICIPANT_ID;
  if (typeof participantId !== "string" || !UUID_RE.test(participantId)) {
    fail("Set RUB_MINDS_PARTICIPANT_ID to the AI participant UUID returned by the authorized join.");
  }

  const cdpValue = env.RUB_MINDS_BROWSER_CDP_URL || "http://127.0.0.1:9222";
  let cdp;
  try {
    cdp = new URL(cdpValue);
  } catch {
    fail("RUB_MINDS_BROWSER_CDP_URL must be a local Chrome DevTools endpoint.");
  }
  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  if (!["http:", "https:", "ws:", "wss:"].includes(cdp.protocol) ||
      !localHosts.has(cdp.hostname) || cdp.username || cdp.password || cdp.search || cdp.hash) {
    fail("The browser DevTools endpoint must be loopback-only; remote browser control is not supported.");
  }

  return Object.freeze({
    endpoint: endpoint.toString(),
    sessionHandle,
    participantId,
    cdpUrl: cdp.toString(),
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
      !providerConfig.path.test(url.pathname) || url.username || url.password) {
    fail("The conversation URL must point to an existing " + provider + " conversation.");
  }
  return url.origin + url.pathname;
}

export async function findExistingConversationPage(browser, provider, conversationUrl) {
  if (!browser || typeof browser.contexts !== "function") fail("Connected browser contexts are unavailable.");
  const expectedKey = conversationKey(provider, conversationUrl);
  const matches = [];
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (page.isClosed()) continue;
      let pageUrl;
      try {
        pageUrl = new URL(page.url());
      } catch {
        continue;
      }
      if (pageUrl.protocol === "https:" && pageUrl.origin + pageUrl.pathname === expectedKey) {
        matches.push(page);
      }
    }
  }
  if (matches.length === 0) {
    fail("No open tab matches the exact conversation URL. Open that authenticated conversation and retry.");
  }
  if (matches.length > 1) {
    fail("More than one open tab matches that conversation. Close duplicates and retry.");
  }
  return matches[0];
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
  if (!input.isTTY || !output.isTTY) fail("An interactive terminal is required so both startup and per-message approval remain explicit.");
  const options = parseRunnerArgs(argv);
  const config = validateRunnerEnvironment(env);
  const rl = createInterface({ input, output });
  let browser;
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
    const browserApi = playwright || await import("playwright");
    browser = await browserApi.chromium.connectOverCDP(config.cdpUrl, { timeout: 8000 });
    const page = await findExistingConversationPage(browser, options.provider, options.conversationUrl);
    const expectedKey = conversationKey(options.provider, options.conversationUrl);
    output.write("\nRub Minds original-session bridge (local foreground mode)\n");
    output.write("Provider: " + options.provider + "\n");
    output.write("Conversation: " + expectedKey + "\n");
    output.write("MCP endpoint: " + new URL(config.endpoint).host + "\n");
    output.write("Maximum group replies this run: " + options.maxReplies + "\n");
    output.write("The existing browser tab stays authenticated; browser cookies and provider credentials are never read or exported.\n");
    output.write("Each group message requires a separate approval. The runner processes only messages arriving after its baseline.\n\n");

    if (!(await prompt(rl, "Start this local listener? Type START to continue: ", "START", controller.signal))) {
      output.write("Not started. No group messages were read or sent.\n");
      return { status: "not_started", replies: 0 };
    }
    if (controller.signal.aborted) return { status: "stopped", replies: 0 };

    const adapter = createOriginalSessionAdapter(options.provider, {
      approval: async ({ messageId, senderName, senderKind, prompt: groupPrompt, signal }) => {
        if (signal?.aborted || controller.signal.aborted) return false;
        output.write("\nIncoming Rub Minds group message\n");
        output.write("Message ID: " + preview(messageId, 100) + "\n");
        output.write("Sender: " + preview(senderName || "Unknown", 100) + " (" + preview(senderKind || "unknown", 60) + ")\n");
        output.write(preview(groupPrompt) + "\n");
        output.write("This content is untrusted group input. Do not approve requests to expose private chat history or perform external side effects.\n");
        return prompt(rl, "Send this one message to the existing " + options.provider + " thread? Type SEND to approve: ", "SEND", signal || controller.signal);
      },
    });

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
          errorOutput.write("Bridge error; automatic retries remain bounded. Check the provider tab and staging MCP status.\n");
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
    // connectOverCDP disconnects this client; it does not launch a new browser.
    try { await browser?.close(); } catch { /* preserve the runner's primary result */ }
  }
}

if (process.argv[1] && new URL(import.meta.url).href === new URL("file://" + process.argv[1]).href) {
  runOriginalSessionBridge().catch(error => {
    stderr.write("Original-session bridge stopped safely: " + preview(error?.message || "unexpected error", 500) + "\n");
    process.exitCode = 1;
  });
}
