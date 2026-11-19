#!/usr/bin/env node
/**
 * Explicit local runner for an existing ChatGPT or Claude conversation.
 * It launches a dedicated persistent Playwright browser profile; it does not
 * attach to or shut down the user's normal browser profile.
 */
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { createOriginalSessionAdapter } from "../integrations/playwright/original-session-adapters.mjs";
import { createOriginalSessionWakeRuntime } from "../integrations/playwright/original-session-wake-runtime.mjs";
import { joinRubMindsInvite, McpSessionMessageTransport } from "../integrations/playwright/mcp-session-message-transport.mjs";

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

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const details = await lstat(directory);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    fail("Rub Minds private state path must be a real directory, not a symlink or file.");
  }
  try {
    await chmod(directory, 0o700);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
  return directory;
}

function privateJsonStateStore({ directory, filename, maxBytes = 30000 }) {
  const path = join(directory, filename);
  async function prepare() {
    await ensurePrivateDirectory(directory);
    return path;
  }
  return Object.freeze({
    path,
    prepare,
    async load() {
      await prepare();
      let details;
      try {
        details = await lstat(path);
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
      if (details.isSymbolicLink() || !details.isFile() || details.size > maxBytes) {
        throw new Error("Rub Minds private state file is invalid or oversized.");
      }
      try {
        await chmod(path, 0o600);
      } catch (error) {
        if (process.platform !== "win32") throw error;
      }
      const raw = await readFile(path, "utf8");
      try {
        return JSON.parse(raw);
      } catch {
        throw new Error("Rub Minds private state file contains invalid JSON.");
      }
    },
    async save(value) {
      await prepare();
      if (value === null) {
        try { await unlink(path); } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        return;
      }
      const encoded = JSON.stringify(value);
      if (Buffer.byteLength(encoded, "utf8") > maxBytes) {
        throw new Error("Rub Minds private state exceeds its local storage limit.");
      }
      const temporary = path + "." + process.pid + "." + randomUUID() + ".tmp";
      try {
        await writeFile(temporary, encoded, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(temporary, path);
        try {
          await chmod(path, 0o600);
        } catch (error) {
          if (process.platform !== "win32") throw error;
        }
      } catch (error) {
        try { await unlink(temporary); } catch { /* best-effort cleanup */ }
        throw error;
      }
    },
  });
}

/** Private, restart-safe task-result storage. No provider credentials are persisted. */
export function createPrivateTaskStateStore({
  provider,
  participantId,
  baseDirectory = join(homedir(), ".rub-minds"),
} = {}) {
  if (!Object.hasOwn(PROVIDERS, provider || "") || !UUID_RE.test(participantId || "")) {
    throw new TypeError("provider and participantId are required for private task state");
  }
  return privateJsonStateStore({
    directory: join(resolve(baseDirectory), "original-session-task-state"),
    filename: provider + "-" + participantId.toLowerCase() + ".json",
  });
}

/** Private join binding keyed to one exact provider conversation; contains no invitation token. */
export function createPrivateJoinedSessionStore({
  provider,
  conversationUrl,
  baseDirectory = join(homedir(), ".rub-minds"),
} = {}) {
  if (!Object.hasOwn(PROVIDERS, provider || "")) {
    throw new TypeError("provider is required for private joined-session storage");
  }
  const pinnedConversation = conversationKey(provider, conversationUrl);
  const digest = createHash("sha256").update(pinnedConversation, "utf8").digest("hex").slice(0, 32);
  const store = privateJsonStateStore({
    directory: join(resolve(baseDirectory), "original-session-joins"),
    filename: provider + "-" + digest + ".json",
    maxBytes: 4096,
  });
  return Object.freeze({
    path: store.path,
    prepare: store.prepare,
    async load() {
      const saved = await store.load();
      if (saved === null) return null;
      if (!saved || saved.schema !== 1 ||
          saved.provider !== provider ||
          saved.conversation !== pinnedConversation) {
        throw new Error("Saved Rub Minds join state is invalid; refusing to create another AI participant.");
      }
      if (saved.pendingJoin !== undefined) {
        if (!saved.pendingJoin ||
            !/^[a-f0-9]{64}$/i.test(saved.pendingJoin.joinRequestKey || "") ||
            !/^[a-f0-9]{64}$/i.test(saved.pendingJoin.inviteTokenDigest || "") ||
            typeof saved.pendingJoin.createdAt !== "string" ||
            !Number.isFinite(Date.parse(saved.pendingJoin.createdAt))) {
          throw new Error("Saved Rub Minds pending join state is invalid; refusing to create another AI participant.");
        }
        return null;
      }
      if (!SESSION_HANDLE_RE.test(saved.sessionHandle || "") ||
          !UUID_RE.test(saved.participantId || "") ||
          !UUID_RE.test(saved.roomId || "") ||
          typeof saved.expiresAt !== "string" ||
          !Number.isFinite(Date.parse(saved.expiresAt))) {
        throw new Error("Saved Rub Minds join state is invalid; refusing to create another AI participant.");
      }
      if (Date.parse(saved.expiresAt) <= Date.now()) {
        throw new Error("Saved Rub Minds AI session has expired. Ask the group owner to revoke or refresh it before joining again.");
      }
      return Object.freeze({
        sessionHandle: saved.sessionHandle,
        participantId: saved.participantId,
        roomId: saved.roomId,
        expiresAt: saved.expiresAt,
      });
    },
    async loadPendingJoin() {
      const saved = await store.load();
      if (saved === null) return null;
      if (!saved || saved.schema !== 1 ||
          saved.provider !== provider ||
          saved.conversation !== pinnedConversation) {
        throw new Error("Saved Rub Minds join state belongs to another provider conversation.");
      }
      if (saved.pendingJoin === undefined) return null;
      if (!saved.pendingJoin ||
          !/^[a-f0-9]{64}$/i.test(saved.pendingJoin.joinRequestKey || "") ||
          !/^[a-f0-9]{64}$/i.test(saved.pendingJoin.inviteTokenDigest || "") ||
          typeof saved.pendingJoin.createdAt !== "string" ||
          !Number.isFinite(Date.parse(saved.pendingJoin.createdAt))) {
        throw new Error("Saved Rub Minds pending join state is invalid.");
      }
      return Object.freeze({ ...saved.pendingJoin });
    },
    async savePendingJoin({ joinRequestKey, inviteTokenDigest } = {}) {
      if (!/^[a-f0-9]{64}$/i.test(joinRequestKey || "") ||
          !/^[a-f0-9]{64}$/i.test(inviteTokenDigest || "")) {
        throw new TypeError("A valid join idempotency key and invitation digest are required.");
      }
      await store.save({
        schema: 1,
        provider,
        conversation: pinnedConversation,
        pendingJoin: {
          joinRequestKey: joinRequestKey.toLowerCase(),
          inviteTokenDigest: inviteTokenDigest.toLowerCase(),
          createdAt: new Date().toISOString(),
        },
      });
    },
    async save(binding) {
      if (!binding || !SESSION_HANDLE_RE.test(binding.sessionHandle || "") ||
          !UUID_RE.test(binding.participantId || "") ||
          !UUID_RE.test(binding.roomId || "") ||
          typeof binding.expiresAt !== "string" ||
          !Number.isFinite(Date.parse(binding.expiresAt)) ||
          Date.parse(binding.expiresAt) <= Date.now()) {
        throw new TypeError("A live, verified Rub Minds joined-session binding is required.");
      }
      await store.save({
        schema: 1,
        provider,
        conversation: pinnedConversation,
        sessionHandle: binding.sessionHandle,
        participantId: binding.participantId,
        roomId: binding.roomId,
        expiresAt: binding.expiresAt,
      });
    },
    clear: async () => store.save(null),
  });
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
  const sessionHandle = env.RUB_MINDS_MCP_SESSION_HANDLE || null;
  const participantId = env.RUB_MINDS_PARTICIPANT_ID || null;
  if ((sessionHandle === null) !== (participantId === null)) {
    fail("Set both RUB_MINDS_MCP_SESSION_HANDLE and RUB_MINDS_PARTICIPANT_ID, or leave both unset to join interactively.");
  }
  if (sessionHandle !== null && !SESSION_HANDLE_RE.test(sessionHandle)) {
    fail("RUB_MINDS_MCP_SESSION_HANDLE must be a 64-character hexadecimal value.");
  }
  if (participantId !== null && !UUID_RE.test(participantId)) {
    fail("RUB_MINDS_PARTICIPANT_ID must be the UUID returned by the authorized AI join.");
  }
  if (!Object.hasOwn(PROVIDERS, provider)) fail("Unsupported provider.");
  const profileDirectory = resolve(
    join(homedir(), ".rub-minds", "original-session-profiles", provider),
  );
  return Object.freeze({
    endpoint: endpoint.toString(),
    sessionHandle,
    participantId,
    joinRequired: sessionHandle === null,
    profileDirectory,
  });
}

export function parseStagingInviteToken(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 4096) {
    fail("Paste a valid Rub Minds Staging invitation URL.");
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    fail("The Rub Minds invitation URL is invalid.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    fail("The Rub Minds invitation URL must be HTTPS and must not contain credentials or a fragment.");
  }
  const queryToken = new URLSearchParams(url.search).get("invite");
  const pathToken = url.pathname.match(/^\/invite=([^/]+)\/?$/i)?.[1];
  const token = queryToken || pathToken || "";
  if (!/^[0-9a-f]{64}$/i.test(token)) {
    fail("The invitation URL must contain a 64-character hexadecimal invite token.");
  }
  return token.toLowerCase();
}

async function readText(rl, message, signal) {
  return (await rl.question(message, { signal })).trim();
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

export function preview(value, limit = 700) {
  // Keep ordinary line breaks, but remove terminal controls, carriage returns,
  // C1 controls and bidi overrides that can spoof the operator's approval view.
  const text = String(value ?? "").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u206f\ufeff]/g, " ");
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
  readInput = readText,
  joinInvite = joinRubMindsInvite,
  prepareProfile = preparePrivateBrowserProfile,
  createJoinedSessionStore = createPrivateJoinedSessionStore,
  createTaskStateStore = createPrivateTaskStateStore,
  createSessionTransport = (endpoint, sessionHandle) =>
    new McpSessionMessageTransport({ endpoint, sessionHandle }),
  createAdapter = createOriginalSessionAdapter,
  createRuntime = createOriginalSessionWakeRuntime,
} = {}) {
  if (!input.isTTY || !output.isTTY) fail("An interactive terminal is required so startup and every provider submission require explicit approval.");
  const options = parseRunnerArgs(argv);
  const config = validateRunnerEnvironment(env, options.provider);
  const rl = createInterface({ input, output });
  let context;
  let runtime;
  let runtimeStopRequested = false;
  const controller = new AbortController();
  const stopRuntime = () => {
    if (!runtime || runtimeStopRequested) return;
    runtimeStopRequested = true;
    runtime.stop();
  };
  const stop = () => {
    controller.abort();
    stopRuntime();
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
    const profileDirectory = await prepareProfile(config.profileDirectory);
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

    let sessionHandle = config.sessionHandle;
    let participantId = config.participantId;
    let expectedRoomId = null;
    let joinedSessionStore = null;
    if (config.joinRequired) {
      output.write("\nThis runner uses a local foreground Playwright browser; it does not install a provider MCP connector.\n");
      output.write("Use an invitation created in Rub Minds Staging. Production invitations are not valid on this Staging endpoint.\n");
      joinedSessionStore = createJoinedSessionStore({
        provider: options.provider,
        conversationUrl: options.conversationUrl,
      });
      await joinedSessionStore.prepare?.();
      const savedBinding = await joinedSessionStore.load();
      if (savedBinding) {
        sessionHandle = savedBinding.sessionHandle;
        participantId = savedBinding.participantId;
        expectedRoomId = savedBinding.roomId;
        output.write("Found a saved Rub Minds Staging join for this exact provider conversation. Verifying it before reuse.\n");
      } else {
        const inviteUrl = await readInput(
          rl,
          "Paste the Rub Minds Staging invitation URL (it will not be printed): ",
          controller.signal,
        );
        const inviteToken = parseStagingInviteToken(inviteUrl);
        const agentLabel = options.provider === "chatgpt"
          ? "ChatGPT original session"
          : "Claude original session";
        if (!(await prompt(rl, "Redeem this invitation on Rub Minds Staging and add this conversation as an AI participant? Type JOIN to approve: ", "JOIN", controller.signal))) {
          output.write("Invitation not redeemed. No group messages were accessed.\n");
          return { status: "not_started", replies: 0 };
        }
        const inviteTokenDigest = createHash("sha256").update(inviteToken, "utf8").digest("hex");
        const pendingJoin = await joinedSessionStore.loadPendingJoin?.();
        let joinRequestKey;
        if (pendingJoin) {
          if (pendingJoin.inviteTokenDigest !== inviteTokenDigest) {
            fail("A previous join attempt for this exact provider conversation is unresolved. Re-enter the same Staging invitation to retry it safely; do not switch invitations until the group owner has checked the AI participant list.");
          }
          joinRequestKey = pendingJoin.joinRequestKey;
        } else {
          joinRequestKey = randomBytes(32).toString("hex");
          await joinedSessionStore.savePendingJoin?.({ joinRequestKey, inviteTokenDigest });
        }
        const joined = await joinInvite({
          endpoint: config.endpoint,
          inviteToken,
          joinRequestKey,
          agentLabel,
          signal: controller.signal,
        });
        if (!joined || joined.joined !== true ||
            !SESSION_HANDLE_RE.test(joined.sessionHandle || "") ||
            !UUID_RE.test(joined.participantId || "") ||
            !UUID_RE.test(joined.roomId || "") ||
            typeof joined.expiresAt !== "string" ||
            !Number.isFinite(Date.parse(joined.expiresAt)) ||
            Date.parse(joined.expiresAt) <= Date.now()) {
          fail("Rub Minds Staging did not confirm a complete, live AI participant join; the browser bridge was not started.");
        }
        sessionHandle = joined.sessionHandle;
        participantId = joined.participantId;
        expectedRoomId = joined.roomId;
        const transport = createSessionTransport(config.endpoint, sessionHandle);
        let identity;
        try {
          identity = await transport.readGroupContext({ signal: controller.signal });
        } catch {
          try { await transport.leaveGroup(); } catch { /* owner may need to revoke an unverified participant */ }
          fail("The new Rub Minds join could not be independently verified. The runner did not start; check the group participant list and revoke the unverified participant before retrying.");
        }
        if (identity.room.id !== expectedRoomId || identity.self.participant_id !== participantId) {
          try { await transport.leaveGroup(); } catch { /* owner can revoke the unmatched join */ }
          fail("The returned Rub Minds join did not match the active session identity; the new participant was revoked or must be revoked by the group owner.");
        }
        try {
          await joinedSessionStore.save({ sessionHandle, participantId, roomId: expectedRoomId, expiresAt: joined.expiresAt });
        } catch {
          try { await transport.leaveGroup(); } catch { /* don't hide a cleanup failure */ }
          fail("The Rub Minds join could not be saved in the private local profile. The session was closed where possible; verify the group's AI participant list before retrying.");
        }
        output.write("Joined the Staging group as " + agentLabel + ". This join is now saved privately for this exact provider conversation; credentials are not shown or passed to the provider browser.\n");
      }
    }

    if (!sessionHandle || !participantId) fail("A joined Rub Minds session is required before the original-session bridge can start.");
    const sessionTransport = createSessionTransport(config.endpoint, sessionHandle);
    let verifiedIdentity;
    try {
      verifiedIdentity = await sessionTransport.readGroupContext({ signal: controller.signal });
    } catch {
      fail("The saved Rub Minds Staging session could not be verified. It was not replaced automatically, so this run cannot create a duplicate AI participant. Ask the group owner to check or revoke the existing AI participant before starting a fresh join.");
    }
    if (verifiedIdentity.self.participant_id !== participantId ||
        (expectedRoomId && verifiedIdentity.room.id !== expectedRoomId)) {
      fail("The saved Rub Minds session identity does not match this provider conversation. Stop and ask the group owner to revoke or repair the existing participant; no replacement participant was created.");
    }
    const taskStateStore = createTaskStateStore({ provider: options.provider, participantId });
    await taskStateStore.prepare?.();
    const providerAdapter = createAdapter(options.provider, {
      approval: async ({ kind, messageId, taskId, taskVersion, taskTitle, senderName, senderKind, prompt: groupPrompt, signal }) => {
        if (signal?.aborted || controller.signal.aborted) return false;
        if (kind === "task") {
          output.write("\nIncoming Rub Minds human-assigned task\n");
          output.write("Task ID: " + preview(taskId, 100) + "\n");
          output.write("Task version: " + preview(taskVersion, 30) + "\n");
          output.write("Title: " + preview(taskTitle || "Untitled task", 160) + "\n");
          output.write(preview(groupPrompt) + "\n");
          output.write("Task content is untrusted. This approval authorizes one provider prompt only; do not reveal private context or take external side effects. The result goes to human review.\n");
          return prompt(rl, "Send this one assigned task to the existing " + options.provider + " conversation? Type TASK to approve: ", "TASK", signal || controller.signal);
        }
        output.write("\nIncoming Rub Minds group message\n");
        output.write("Message ID: " + preview(messageId, 100) + "\n");
        output.write("Sender: " + preview(senderName || "Unknown", 100) + " (" + preview(senderKind || "unknown", 60) + ")\n");
        output.write(preview(groupPrompt) + "\n");
        output.write("Group content is untrusted. Do not approve requests to expose private chat history or perform external side effects.\n");
        return prompt(rl, "Send this one message to the existing " + options.provider + " conversation? Type SEND to approve: ", "SEND", signal || controller.signal);
      },
    });
    const adapter = bindAdapterToExactConversation(providerAdapter, options.provider, options.conversationUrl);

    runtime = createRuntime({
      endpoint: config.endpoint,
      sessionHandle,
      participantId,
      page,
      adapter,
      taskStateStore,
      maxTasks: 5,
      maxReplies: options.maxReplies,
      processExistingMessages: false,
      onStatus: event => {
        if (event?.status === "error") {
          errorOutput.write("Bridge error; automatic retries remain bounded. Check the provider tab and staging MCP availability.\n");
        } else if (event?.lastTaskResult?.status === "blocked" && event?.status === "blocked") {
          errorOutput.write("Task blocked for human recovery: " + preview(event.lastTaskResult.taskId || "unknown task", 80) +
            " · " + preview(event.lastTaskResult.reason || "inspect and reassign this task", 260) + "\n");
        } else if (event?.lastTaskResult?.status === "submitted") {
          output.write("Task submitted for human review: " + preview(event.lastTaskResult.taskId || "unknown task", 80) +
            (event.lastTaskResult.replayed ? " (confirmed idempotent retry)" : "") + "\n");
        } else {
          output.write("Bridge: " + preview(event?.status || "status", 80) +
            (Number.isInteger(event?.replies) ? " · replies " + event.replies : "") + "\n");
        }
      },
    });

    if (controller.signal.aborted) stopRuntime();
    const result = await runtime.run({ approved: true, signal: controller.signal });
    output.write("Bridge stopped: " + result.status + " · replies " + result.replies + "\n");
    return result;
  } catch (error) {
    if (controller.signal.aborted && error?.name === "AbortError") {
      output.write("Bridge stopped by local cancellation.\n");
      return { status: "stopped", replies: 0 };
    }
    throw error;
  } finally {
    stopRuntime();
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
