import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadOrCreateHostIdentity } from "../integrations/backroom/host-identity.mjs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { HostPairingAuthority } from "../integrations/backroom/host-pairing.mjs";

const DEFAULT_ORIGINS = [
  "https://rub-minds.vercel.app",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];
const MAX_BODY_BYTES = 16 * 1024;
const PROTOCOL_VERSION = "1";
const noCache = {
  "Cache-Control": "no-store, max-age=0",
  "Pragma": "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function parseOrigins(value) {
  if (!value) return DEFAULT_ORIGINS;
  const origins = value.split(",").map(value => value.trim()).filter(Boolean);
  // Exact origins only. URLs, paths, wildcard domains and implicit substring matching are forbidden.
  return origins;
}

function disabledBrowserRuntime() {
  const status = () => ({ running: false, pages: 0, capabilities: {
    browserDraft: false, browserCanonicalWake: false, desktopAccessibility: false, androidAccessibility: false, terminal: false,
  } });
  const unavailable = async () => { throw new Error("browser_runtime_unavailable"); };
  return {
    status, stop: async () => status(), start: unavailable, openUrl: unavailable, listPages: async () => [],
    listTargets: async () => [], startSelection: unavailable, cancelSelection: async () => false, getSelection: async () => ({ state: "unavailable" }),
    registerSelectedTarget: unavailable, unregisterTarget: async () => false, draft: unavailable,
    enableContinuousWake: unavailable, revokeContinuousWake: async () => false, wake: unavailable,
  };
}
function writeJson(response, status, body, corsHeaders = {}) {
  response.writeHead(status, { ...noCache, ...corsHeaders, "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) { tooLarge = true; continue; }
    if (!tooLarge) chunks.push(chunk);
  }
  if (tooLarge) throw Object.assign(new Error("request_too_large"), { status: 413 });
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
    return result;
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}
function validLoopbackHost(header, port) {
  return header === `127.0.0.1:${port}` || header === `localhost:${port}` ||
    (port === 80 && (header === "127.0.0.1" || header === "localhost"));
}
function bearer(request) {
  const value = request.headers.authorization ?? "";
  const match = /^Bearer ([a-f0-9]{64})$/i.exec(value);
  return match?.[1] ?? null;
}

/**
 * Creates a loopback-only local host control plane. Pairing is ephemeral and
 * never enables native input on its own. Browser/desktop/Android drivers must be
 * registered separately and declare their real capabilities.
 */
export function createBackroomHostServer({
  port = 43781, host = "127.0.0.1", allowedOrigins = parseOrigins(process.env.BACKROOM_ALLOWED_ORIGINS),
  pairingCode, hostId = randomUUID(), enrollmentDigest = null, now = () => Date.now(), pairingTtlMs, sessionTtlMs, maxPairAttempts, browserRuntime, wakeService, multiSurfaceRuntime,
} = {}) {
  if (host !== "127.0.0.1") throw new TypeError("Backroom host must bind to IPv4 loopback only");
  if (enrollmentDigest !== null && (typeof enrollmentDigest !== "string" || !/^[a-f0-9]{64}$/.test(enrollmentDigest))) throw new TypeError("Invalid enrollment digest");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError("invalid port");
  const authority = new HostPairingAuthority({ allowedOrigins, pairingCode, hostId, now, pairingTtlMs, sessionTtlMs, maxPairAttempts });
  const browser = browserRuntime ?? disabledBrowserRuntime();
  let actualPort = port;
  let killSwitchTripped = false;
  const server = createServer(async (request, response) => {
    if (typeof request.url !== "string" || !request.url.startsWith("/") || request.url.startsWith("//")) {
      writeJson(response, 400, { error: "invalid_request_target" });
      return;
    }
    const requestOrigin = request.headers.origin;
    const requestHost = request.headers.host ?? "";
    if (!validLoopbackHost(requestHost, actualPort)) {
      writeJson(response, 403, { error: "invalid_host_header" });
      return;
    }
    if (!authority.canServeOrigin(requestOrigin)) {
      writeJson(response, 403, { error: "origin_not_allowed" });
      return;
    }
    const cors = {
      "Access-Control-Allow-Origin": requestOrigin,
      "Vary": "Origin",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "300",
    };
    if (request.method === "OPTIONS") {
      response.writeHead(204, { ...noCache, ...cors });
      response.end();
      return;
    }
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${actualPort}`);
    if (url.search || url.hash) {
      writeJson(response, 400, { error: "query_not_supported" }, cors);
      return;
    }
    if (request.method === "GET" && url.pathname === "/health") {
      writeJson(response, killSwitchTripped ? 423 : 200, {
        status: killSwitchTripped ? "stopped" : "ok",
        protocolVersion: PROTOCOL_VERSION,
        restartRequired: killSwitchTripped,
      }, cors);
      return;
    }
    if (url.pathname === "/v1/host/stop") {
      if (request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed" }, cors);
        return;
      }
      if (killSwitchTripped) {
        writeJson(response, 423, { error: "host_stopped", hint: "Emergency stop is latched. Restart the local host process to pair again." }, cors);
        return;
      }
      const token = bearer(request);
      if (!token || !authority.authorize({ origin: requestOrigin, token })) {
        writeJson(response, 401, { error: "host_session_invalid" }, cors);
        return;
      }
      // Latch the stop before awaiting the browser close. All new operations
      // fail closed while in-flight Playwright operations are interrupted by
      // context closure. Re-pairing requires restarting the host process.
      killSwitchTripped = true;
      const sessionsRevoked = authority.revokeAll({ origin: requestOrigin, token });
      let closeError = null;
      try { await wakeService?.stop?.(); } catch { closeError = true; }
      try { await multiSurfaceRuntime?.stop?.(); } catch { closeError = true; }
      try { await browser.stop(); } catch { closeError = true; }
      const browserClosed = browser.status()?.running !== true;
      const stopped = sessionsRevoked && browserClosed && !closeError;
      writeJson(response, stopped ? 200 : 503, {
        stopped: true,
        browserClosed,
        sessionsRevoked,
        restartRequired: true,
        error: stopped ? undefined : "emergency_stop_incomplete",
        hint: stopped
          ? "The managed browser is closed and all paired sessions are revoked. Restart the local host process before pairing again."
          : "Emergency stop is latched and pairing is blocked, but browser closure could not be fully verified. Stop the local host process with Ctrl+C and close any remaining browser windows.",
      }, cors);
      return;
    }
    if (killSwitchTripped) {
      writeJson(response, 423, {
        error: "host_stopped",
        hint: "Emergency stop is latched. Restart the local host process to pair again.",
      }, cors);
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/pair") {
      try {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
          writeJson(response, 415, { error: "application_json_required" }, cors);
          return;
        }
        const input = await readJson(request);
        const paired = authority.pair({ origin: requestOrigin, pairingCode: input.pairingCode, clientLabel: input.clientLabel });
        writeJson(response, 200, { hostId: paired.hostId, sessionToken: paired.token, expiresAt: paired.expiresAt,
          clientLabel: paired.clientLabel, protocolVersion: PROTOCOL_VERSION }, cors);
      } catch (error) {
        const code = error?.message;
        const status = error?.status ?? (code === "pairing_rate_limited" ? 429 :
          code === "origin_not_allowed" ? 403 : 401);
        writeJson(response, status, { error: status === 413 ? "request_too_large" : "pairing_failed" }, cors);
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/host") {
      const session = authority.authorize({ origin: requestOrigin, token: bearer(request) });
      if (!session) { writeJson(response, 401, { error: "host_session_invalid" }, cors); return; }
      const runtimeStatus = browser.status();
      const executionReady = Object.values(runtimeStatus.capabilities).some(Boolean);
      writeJson(response, 200, {
        hostId: session.hostId, label: session.clientLabel, expiresAt: session.expiresAt,
        ...(enrollmentDigest ? { enrollmentDigest } : {}),
        protocolVersion: PROTOCOL_VERSION, connected: true, executionReady,
        browserPages: runtimeStatus.pages,
        capabilities: runtimeStatus.capabilities,
        nextStep: runtimeStatus.running
          ? "Register an input target in the managed browser; native drivers remain unavailable."
          : "Launch the managed browser to register a browser input target.",
      }, cors);
      return;
    }
    if(request.method==="POST" && url.pathname==="/v1/backroom/configure"){
      const authorized=authority.authorize({origin:requestOrigin,token:bearer(request)});
      if(!authorized){writeJson(response,401,{error:"host_session_invalid"},cors);return;}
      if(!wakeService || typeof wakeService.configure!=="function"){
        writeJson(response,503,{error:"remote_wake_unavailable"},cors);return;
      }
      if(!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"]??"")){
        writeJson(response,415,{error:"application_json_required"},cors);return;
      }
      try{
        const input=await readJson(request);
        if(!input||typeof input!=='object'||Array.isArray(input)||
          Object.keys(input).some(key=>!['sessionDigest','bindingId'].includes(key))){
          writeJson(response,400,{error:'invalid_remote_wake_configuration'},cors);return;
        }
        const status=wakeService.configure(input);
        writeJson(response,200,status,cors);
      }catch{
        writeJson(response,400,{error:"invalid_remote_wake_configuration"},cors);
      }
      return;
    }
    // Optional native/terminal service must be registered by trusted local code,
    // not by remote JSON. No arbitrary shell, OS selector or driver installation.
    if(url.pathname.startsWith("/v1/surfaces/")){
      const session=authority.authorize({origin:requestOrigin,token:bearer(request)});
      if(!session){writeJson(response,401,{error:"host_session_invalid"},cors);return;}
      if(!multiSurfaceRuntime){
        writeJson(response,503,{error:"native_runtime_unavailable"},cors);return;
      }
      if(request.method==="GET"&&url.pathname==="/v1/surfaces/targets"){
        writeJson(response,200,{targets:multiSurfaceRuntime.list()},cors);return;
      }
      if(request.method==="POST"&&url.pathname==="/v1/surfaces/draft"){
        if(!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"]??"")){
          writeJson(response,415,{error:"application_json_required"},cors);return;
        }
        try{
          const input=await readJson(request);
          if(!input||input.approved!==true||!input.command||typeof input.command!=="object"||
             Object.keys(input).some(key=>!["approved","command"].includes(key))){
            writeJson(response,403,{error:"explicit_draft_approval_required"},cors);return;
          }
          const result=await multiSurfaceRuntime.draft({command:input.command,approved:true});
          writeJson(response,result.state==="completed"?200:409,result,cors);
        }catch{
          writeJson(response,409,{error:"native_draft_unavailable_or_denied"},cors);
        }
        return;
      }
      writeJson(response,404,{error:"not_found"},cors);return;
    }
    if (url.pathname.startsWith("/v1/browser/")) {
      if (request.method !== "GET" && request.method !== "POST") {
        writeJson(response, 405, { error: "method_not_allowed" }, cors);
        return;
      }
      const session = authority.authorize({ origin: requestOrigin, token: bearer(request) });
      if (!session) {
        writeJson(response, 401, { error: "host_session_invalid" }, cors);
        return;
      }
      try {
        if (request.method === "GET" && url.pathname === "/v1/browser/status") {
          writeJson(response, 200, browser.status(), cors);
          return;
        }
        if (request.method === "GET" && url.pathname === "/v1/browser/pages") {
          writeJson(response, 200, { pages: await browser.listPages() }, cors);
          return;
        }
        if (request.method === "GET" && url.pathname === "/v1/browser/targets") {
          writeJson(response, 200, { targets: await browser.listTargets() }, cors);
          return;
        }
        const selectionMatch = /^\/v1\/browser\/selection\/([a-f0-9-]{36})\/([a-f0-9-]{36})$/i.exec(url.pathname);
        if (request.method === "GET" && selectionMatch) {
          writeJson(response, 200, await browser.getSelection(selectionMatch[1], selectionMatch[2]), cors);
          return;
        }
        if (request.method === "POST" && url.pathname === "/v1/browser/open") {
          if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
            writeJson(response, 415, { error: "application_json_required" }, cors);
            return;
          }
          const input = await readJson(request);
          if (typeof input.url !== "string" || input.url.length > 2048) {
            writeJson(response, 400, { error: "invalid_url" }, cors);
            return;
          }
          writeJson(response, 200, await browser.openUrl(input.url), cors);
          return;
        }
        if (request.method === "POST" && url.pathname === "/v1/browser/start") {
          try {
            writeJson(response, 200, await browser.start(), cors);
          } catch {
            writeJson(response, 503, { error: "browser_runtime_unavailable", hint: "Install the Playwright Chromium browser on this computer and retry." }, cors);
          }
          return;
        }
        if (request.method === "POST" && url.pathname === "/v1/browser/stop") {
          await wakeService?.stop?.();
          writeJson(response, 200, await browser.stop(), cors);
          return;
        }
        if (request.method === "POST" && [
          "/v1/browser/select", "/v1/browser/select/cancel", "/v1/browser/targets", "/v1/browser/targets/unregister", "/v1/browser/draft",
          "/v1/browser/wake/grants", "/v1/browser/wake/grants/revoke", "/v1/browser/wake",
        ].includes(url.pathname)) {
          if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
            writeJson(response, 415, { error: "application_json_required" }, cors);
            return;
          }
          const input = await readJson(request);
          if (url.pathname === "/v1/browser/select/cancel") {
            if (typeof input.pageId !== "string" || !/^[a-f0-9-]{36}$/i.test(input.pageId) ||
              typeof input.roomId !== "string" || !/^[a-f0-9-]{36}$/i.test(input.roomId) ||
              typeof input.attemptId !== "string" || !/^[a-f0-9-]{36}$/i.test(input.attemptId)) {
              writeJson(response, 400, { error: "invalid_page_room_or_attempt_id" }, cors);
              return;
            }
            const cancelled = await browser.cancelSelection(input.pageId, input.roomId, input.attemptId);
            writeJson(response, 200, { cancelled }, cors);
            return;
          }
          if (url.pathname === "/v1/browser/select") {
            if (typeof input.pageId !== "string" || !/^[a-f0-9-]{36}$/i.test(input.pageId) ||
              typeof input.roomId !== "string" || !/^[a-f0-9-]{36}$/i.test(input.roomId)) {
              writeJson(response, 400, { error: "invalid_page_or_room_id" }, cors);
              return;
            }
            writeJson(response, 200, await browser.startSelection(input.pageId, input.roomId), cors);
            return;
          }
          if (url.pathname === "/v1/browser/targets/unregister") {
            if (typeof input.targetId !== "string" || !/^[a-f0-9-]{36}$/i.test(input.targetId) ||
              typeof input.roomId !== "string" || !/^[a-f0-9-]{36}$/i.test(input.roomId)) {
              writeJson(response, 400, { error: "invalid_target_or_room_id" }, cors);
              return;
            }
            const removed = await browser.unregisterTarget(input.targetId, input.roomId);
            writeJson(response, removed ? 200 : 404, { removed }, cors);
            return;
          }
          if (url.pathname === "/v1/browser/targets") {
            if (typeof input.pageId !== "string" || !/^[a-f0-9-]{36}$/i.test(input.pageId) ||
              typeof input.roomId !== "string" || !/^[a-f0-9-]{36}$/i.test(input.roomId) ||
              typeof input.attemptId !== "string" || !/^[a-f0-9-]{36}$/i.test(input.attemptId)) {
              writeJson(response, 400, { error: "invalid_page_room_or_attempt_id" }, cors);
              return;
            }
            writeJson(response, 201, await browser.registerSelectedTarget(input.pageId, input.roomId, input.attemptId), cors);
            return;
          }
          if (url.pathname === "/v1/browser/wake/grants") {
            if (input.confirmed !== true) {
              writeJson(response, 403, { error: "explicit_continuous_wake_confirmation_required" }, cors);
              return;
            }
            const id = /^[a-f0-9-]{36}$/i;
            if (typeof input.targetId !== "string" || !id.test(input.targetId) ||
              typeof input.roomId !== "string" || !id.test(input.roomId) ||
              typeof input.participantId !== "string" || !id.test(input.participantId) ||
              typeof input.sessionId !== "string" || !id.test(input.sessionId) ||
              typeof input.bindingId !== "string" || !id.test(input.bindingId)) {
              writeJson(response, 400, { error: "invalid_wake_scope" }, cors);
              return;
            }
            const grant = await browser.enableContinuousWake({
              targetId: input.targetId, roomId: input.roomId, participantId: input.participantId,
              sessionId: input.sessionId, bindingId: input.bindingId, confirmed: true,
              ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
              ...(input.maxPerMinute === undefined ? {} : { maxPerMinute: input.maxPerMinute }),
            });
            if(wakeService){
              try {
                // The remote queue is enabled only after explicit, origin-bound
                // local approval, and only for this pre-enrolled binding.
                await wakeService.activateAndStart(grant,input);
              } catch {
                try { await wakeService.stop(); } catch {}
                browser.revokeContinuousWake({grantId:grant.grantId,
                  targetId:input.targetId,roomId:input.roomId});
                writeJson(response, 503, {error:"remote_wake_activation_failed"}, cors);
                return;
              }
            }
            writeJson(response, 201, grant, cors);
            return;
          }
          if (url.pathname === "/v1/browser/wake/grants/revoke") {
            const id = /^[a-f0-9-]{36}$/i;
            if (typeof input.grantId !== "string" || !id.test(input.grantId) ||
              typeof input.targetId !== "string" || !id.test(input.targetId) ||
              typeof input.roomId !== "string" || !id.test(input.roomId)) {
              writeJson(response, 400, { error: "invalid_wake_grant_scope" }, cors);
              return;
            }
            const revoked = await browser.revokeContinuousWake({ grantId: input.grantId, targetId: input.targetId, roomId: input.roomId });
            if(revoked)await wakeService?.stop?.();
            writeJson(response, revoked ? 200 : 404, { revoked }, cors);
            return;
          }
          if (url.pathname === "/v1/browser/wake") {
            const id = /^[a-f0-9-]{36}$/i;
            if (typeof input.grantId !== "string" || !id.test(input.grantId) ||
              typeof input.targetId !== "string" || !id.test(input.targetId) ||
              typeof input.roomId !== "string" || !id.test(input.roomId) ||
              typeof input.eventId !== "string" || !id.test(input.eventId)) {
              writeJson(response, 400, { error: "invalid_wake_request" }, cors);
              return;
            }
            const result = await browser.wake(input.targetId, input.eventId, input.grantId, { roomId: input.roomId });
            writeJson(response, result.state === "completed" ? 200 : 409, result, cors);
            return;
          }
          if (input.approved !== true) {
            writeJson(response, 403, { error: "explicit_user_approval_required" }, cors);
            return;
          }
          if (typeof input.targetId !== "string" || !/^[a-f0-9-]{36}$/i.test(input.targetId) || typeof input.roomId !== "string" || !/^[a-f0-9-]{36}$/i.test(input.roomId)) {
            writeJson(response, 400, { error: "invalid_target_or_room_id" }, cors);
            return;
          }
          const result = await browser.draft(input.targetId, input.text, { approved: true, roomId: input.roomId });
          writeJson(response, result.state === "completed" ? 200 : 409, result, cors);
          return;
        }
        writeJson(response, 404, { error: "not_found" }, cors);
      } catch (error) {
        const message = typeof error?.message === "string" ? error.message.slice(0, 180) : "browser_operation_failed";
        const status = error?.status ?? (message === "browser_runtime_unavailable" ? 503 : 400);
        const code = message === "request_too_large" ? "request_too_large" :
          message === "invalid_json" ? "invalid_json" :
          status === 503 ? "browser_runtime_unavailable" : "browser_operation_failed";
        writeJson(response, status, { error: code, message }, cors);
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/unpair") {
      const token = bearer(request);
      if (!token || !authority.revoke({ origin: requestOrigin, token })) {
        writeJson(response, 401, { error: "host_session_invalid" }, cors);
        return;
      }
      await wakeService?.stop?.();
      await multiSurfaceRuntime?.stop?.();
      writeJson(response, 200, { revoked: true }, cors);
      return;
    }
    writeJson(response, 404, { error: "not_found" }, cors);
  });
  server.headersTimeout = 8_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  server.setTimeout(15_000, socket => socket.destroy());
  return {
    server,
    authority,
    get pairingCode() { return authority.pairingCode; },
    get killSwitchTripped() { return killSwitchTripped; },
    async start() {
      await new Promise((resolve, reject) => {
        const onError = error => { server.off("listening", onListening); reject(error); };
        const onListening = () => { server.off("error", onError); resolve(); };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
      actualPort = server.address().port;
      return Object.freeze({ host: "127.0.0.1", port: actualPort, hostId: authority.hostId });
    },
    async close() {
      let browserError = null;
      try { await wakeService?.stop?.(); } catch { browserError = new Error("wake_poller_stop_failed"); }
      try { await multiSurfaceRuntime?.stop?.(); } catch { browserError = new Error("native_runtime_stop_failed"); }
      try { await browser.stop(); } catch (error) { browserError = error; }
      if (server.listening) {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
      if (browserError) throw browserError;
    },
  };
}

export async function runBackroomHost() {
  const identity = await loadOrCreateHostIdentity({
    filePath: join(homedir(), ".rub-minds", "backroom", "host-identity.json"),
  });
  const hostId = identity.hostId;
  const { BrowserHostRuntime } = await import("../integrations/backroom/browser-host-runtime.mjs");
  const browserRuntime = new BrowserHostRuntime({ hostId });
  const {createHostWakeService}=await import("../integrations/backroom/host-wake-service.mjs");
  const wakeService=createHostWakeService({
    identity,browserRuntime,
    journalDirectory:join(homedir(),".rub-minds","backroom","wake-execution-journal")
  });
  const gatewayUrl=process.env.BACKROOM_WAKE_GATEWAY_URL;
  const sessionDigest=process.env.BACKROOM_WAKE_SESSION_DIGEST;
  const bindingId=process.env.BACKROOM_WAKE_BINDING_ID;
  const configured=[gatewayUrl,sessionDigest,bindingId].filter(Boolean).length;
  if(configured!==0&&configured!==3)
    throw new Error("Remote wake configuration requires gateway URL, session digest and binding ID together");
  if(configured===3)wakeService.configure({gatewayUrl,sessionDigest,bindingId});
  const instance = createBackroomHostServer({
    hostId,browserRuntime,enrollmentDigest:identity.credentialDigest,wakeService
  });
  const address = await instance.start();
  process.stdout.write([
    "",
    "Rub Minds Backroom local host",
    `Address: http://${address.host}:${address.port}`,
    `Host ID: ${address.hostId}`,
    `Hosted enrollment digest: ${identity.credentialDigest}`,
    "Private host credential is stored only in the local host identity file (not printed).",
    configured===3?"Remote wake binding configured; awaiting explicit local grant.":"Remote wake: not configured. Pair the browser to configure a hosted binding without restarting.",
    `Allowed web origins: ${parseOrigins(process.env.BACKROOM_ALLOWED_ORIGINS).join(", ")}`,
    "Pairing code (one use, expires in 10 minutes):",
    instance.pairingCode,
    "Browser automation is available after installing Playwright Chromium; native phone, desktop accessibility and terminal drivers are not installed.",
    "The Backroom Emergency Stop closes the managed browser, revokes paired sessions and latches the host until this process is restarted.",
    "Keep this terminal private. Stop host with Ctrl+C.",
    "",
  ].join("\n"));
  const stop = async () => { await instance.close(); process.exitCode = 0; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return instance;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runBackroomHost().catch(error => {
    process.stderr.write(`Backroom host failed to start: ${error.message}\n`);
    process.exitCode = 1;
  });
}
