import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadOrCreateHostIdentity, rotateHostIdentity, isHostIdentityRotationPending } from "../integrations/backroom/host-identity.mjs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { HostPairingAuthority } from "../integrations/backroom/host-pairing.mjs";
import { handleWorkspaceHttpRequest } from "../integrations/backroom/workspace-http-api.mjs";
import { createSerializedLocalApproval } from "../integrations/backroom/local-approval-queue.mjs";

const DEFAULT_ORIGINS = [
  "https://rub-minds.vercel.app",
  // Exact authenticated feature-branch Preview used for Backroom staging acceptance.
  "https://rub-minds-git-feat-ba-fce441-abdulrazaqafolarin-droids-projects.vercel.app",
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
    browserDraft: false, browserView: false, browserCanonicalWake: false, desktopAccessibility: false, androidAccessibility: false, terminal: false,
  } });
  const unavailable = async () => { throw new Error("browser_runtime_unavailable"); };
  return {
    status, stop: async () => status(), start: unavailable, openUrl: unavailable, listPages: async () => [],
    listTargets: async () => [], startSelection: unavailable, cancelSelection: async () => false, getSelection: async () => ({ state: "unavailable" }),
    registerSelectedTarget: unavailable, grantView: unavailable, revokeView: () => false,
    captureView: unavailable, selectRegionFromView: unavailable,
    unregisterTarget: async () => false, draft: unavailable,
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
  pairingCode, hostId = randomUUID(), enrollmentDigest = null, now = () => Date.now(), pairingTtlMs, sessionTtlMs, maxPairAttempts, browserRuntime, wakeService, multiSurfaceRuntime, externalWorkspaceRuntime = null, authorizeLocalAction = async () => false,
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
      try { const result = await externalWorkspaceRuntime?.stop?.(); if (result && result.closeFailures > 0) closeError = true; } catch { closeError = true; }
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
      const wakeServiceStatus = wakeService?.status;
      const wakeGatewayHost = wakeServiceStatus?.gatewayHost;
      const wakeBindings = Array.isArray(wakeServiceStatus?.bindings)
        ? wakeServiceStatus.bindings.filter(item =>
          item && typeof item.bindingId === "string" && /^[a-f0-9-]{36}$/i.test(item.bindingId) &&
          typeof item.polling === "boolean" && typeof item.consentActive === "boolean" &&
          typeof item.deactivationPending === "boolean"
        ).slice(0, 10).map(item => ({
          bindingId: item.bindingId, polling: item.polling,
          consentActive: item.consentActive, deactivationPending: item.deactivationPending,
        }))
        : [];
      writeJson(response, 200, {
        hostId: session.hostId, label: session.clientLabel, expiresAt: session.expiresAt,
        ...(enrollmentDigest ? { enrollmentDigest } : {}),
        ...(typeof wakeGatewayHost === "string" ? { wakeGatewayHost } : {}),
        ...(wakeBindings.length ? { wakeBindings } : {}),
        protocolVersion: PROTOCOL_VERSION, connected: true, executionReady,
        browserPages: runtimeStatus.pages,
        capabilities: runtimeStatus.capabilities,
        nextStep: runtimeStatus.running
          ? "Register an input target in the managed browser; native drivers remain unavailable."
          : "Launch the managed browser to register a browser input target.",
      }, cors);
      return;
    }
    if(request.method==="POST" && url.pathname==="/v1/backroom/stop"){
      const authorized=authority.authorize({origin:requestOrigin,token:bearer(request)});
      if(!authorized){writeJson(response,401,{error:"host_session_invalid"},cors);return;}
      let bindingId;
      if(request.headers["content-type"]){
        if(!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"])){
          writeJson(response,415,{error:"application_json_required"},cors);return;
        }
        try{
          const input=await readJson(request);
          if(Object.keys(input).some(key=>key!=="bindingId")||
             (input.bindingId!==undefined&&!/^[a-f0-9-]{36}$/i.test(input.bindingId))){
            writeJson(response,400,{error:"invalid_binding_scope"},cors);return;
          }
          bindingId=input.bindingId;
        }catch{
          writeJson(response,400,{error:"invalid_json"},cors);return;
        }
      }
      try{
        const status=await wakeService?.stop?.(bindingId);
        writeJson(response,200,{stopped:true,bindingId:bindingId??null,
          remoteDeactivationConfirmed:status?.remotelyDeactivated===true},cors);
      }catch{
        writeJson(response,503,{error:"wake_stop_failed"},cors);
      }
      return;
    }
    if(request.method==="POST" && url.pathname==="/v1/backroom/unconfigure"){
      const authorized=authority.authorize({origin:requestOrigin,token:bearer(request)});
      if(!authorized){writeJson(response,401,{error:"host_session_invalid"},cors);return;}
      if(!wakeService||typeof wakeService.unconfigure!=="function"){
        writeJson(response,503,{error:"remote_wake_unavailable"},cors);return;
      }
      if(!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"]??"")){
        writeJson(response,415,{error:"application_json_required"},cors);return;
      }
      try{
        const input=await readJson(request);
        if(typeof input.bindingId!=="string"||!/^[a-f0-9-]{36}$/i.test(input.bindingId)||
          Object.keys(input).some(key=>key!=="bindingId")){
          writeJson(response,400,{error:"invalid_binding_scope"},cors);return;
        }
        writeJson(response,200,await wakeService.unconfigure(input.bindingId),cors);
      }catch{
        writeJson(response,400,{error:"invalid_binding_scope"},cors);
      }
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
          Object.keys(input).some(key=>!['sessionDigest','bindingId','publishableKey'].includes(key))){
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
        const viewMatch = /^\/v1\/browser\/view\/([a-f0-9-]{36})\/([a-f0-9-]{36})\/([a-f0-9-]{36})$/i.exec(url.pathname);
        if (request.method === "GET" && viewMatch) {
          writeJson(response, 200, await browser.captureView(viewMatch[1], viewMatch[2], viewMatch[3]), cors);
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
          "/v1/browser/select", "/v1/browser/select/cancel", "/v1/browser/select-region", "/v1/browser/view/grant", "/v1/browser/view/revoke", "/v1/browser/targets", "/v1/browser/targets/unregister", "/v1/browser/draft",
          "/v1/browser/wake/grants", "/v1/browser/wake/grants/revoke", "/v1/browser/wake",
        ].includes(url.pathname)) {
          if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
            writeJson(response, 415, { error: "application_json_required" }, cors);
            return;
          }
          const input = await readJson(request);
          if (url.pathname === "/v1/browser/view/grant") {
            const id = /^[a-f0-9-]{36}$/i;
            if (typeof input.pageId !== "string" || !id.test(input.pageId) ||
              typeof input.roomId !== "string" || !id.test(input.roomId) ||
              Object.keys(input).some(key => !["pageId", "roomId"].includes(key))) {
              writeJson(response, 400, { error: "invalid_browser_view_scope" }, cors);
              return;
            }
            const discoveredPage = (await browser.listPages()).find(page => page.pageId === input.pageId);
            if (!discoveredPage) {
              writeJson(response, 404, { error: "browser_tab_not_discovered" }, cors);
              return;
            }
            const locallyApproved = await authorizeLocalAction({
              operation: "browser.view", pageId: input.pageId, roomId: input.roomId,
              site: discoveredPage.site, title: discoveredPage.title,
              hostId: authority.hostId, capabilities: ["view"], ttlMs: 300000,
            });
            if (locallyApproved !== true) {
              writeJson(response, 403, { error: "trusted_local_browser_view_approval_denied" }, cors);
              return;
            }
            writeJson(response, 201, await browser.grantView(input.pageId, input.roomId), cors);
            return;
          }
          if (url.pathname === "/v1/browser/view/revoke") {
            const id = /^[a-f0-9-]{36}$/i;
            if (typeof input.pageId !== "string" || !id.test(input.pageId) ||
              typeof input.roomId !== "string" || !id.test(input.roomId) ||
              typeof input.grantId !== "string" || !id.test(input.grantId) ||
              Object.keys(input).some(key => !["pageId", "roomId", "grantId"].includes(key))) {
              writeJson(response, 400, { error: "invalid_browser_view_revoke_scope" }, cors);
              return;
            }
            const revoked = browser.revokeView(input.pageId, input.roomId, input.grantId);
            writeJson(response, revoked ? 200 : 404, { revoked }, cors);
            return;
          }
          if (url.pathname === "/v1/browser/select-region") {
            const id = /^[a-f0-9-]{36}$/i;
            const region = input.region;
            if (typeof input.pageId !== "string" || !id.test(input.pageId) ||
              typeof input.roomId !== "string" || !id.test(input.roomId) ||
              typeof input.frameId !== "string" || !id.test(input.frameId) ||
              !region || typeof region !== "object" || Array.isArray(region) ||
              Object.keys(input).some(key => !["pageId", "roomId", "frameId", "region"].includes(key)) ||
              Object.keys(region).some(key => !["x", "y", "width", "height"].includes(key)) ||
              ["x", "y", "width", "height"].some(key => typeof region[key] !== "number" || !Number.isFinite(region[key]))) {
              writeJson(response, 400, { error: "invalid_view_region_scope" }, cors);
              return;
            }
            const target = await browser.selectRegionFromView(input.pageId, input.roomId, input.frameId, region);
            writeJson(response, 201, target, cors);
            return;
          }
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
          if(url.pathname==="/v1/browser/wake/bindings/revoke"){
            const input=await readJson(request);
            if(typeof input.bindingId!=="string"||!/^[a-f0-9-]{36}$/i.test(input.bindingId)||
              Object.keys(input).some(key=>key!=="bindingId")){
              writeJson(response,400,{error:"invalid_wake_binding_scope"},cors);return;
            }
            const grantRevoked=browser.revokeWakeBinding(input.bindingId)===true;
            const stopStatus=await wakeService?.stop?.(input.bindingId);
            const serviceStopConfirmed=Array.isArray(stopStatus?.bindings)&&
              stopStatus.bindings.some(item=>item?.bindingId===input.bindingId&&item.stopped===true);
            // No local record is not proof of a stopped worker. After a host
            // restart the server binding may still be live, but the in-memory
            // poller/grant has disappeared; report that state as unconfirmed.
            const localPollingStopped=grantRevoked||serviceStopConfirmed;
            writeJson(response,200,{revoked:localPollingStopped,localPollingStopped,grantRevoked,
              remoteDeactivationConfirmed:stopStatus?.remotelyDeactivated===true,
              remoteDeactivationPending:stopStatus?.remotelyDeactivated===false},cors);
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
              typeof input.bindingId !== "string" || !id.test(input.bindingId) ||
              (input.ownerConfirmed !== undefined && typeof input.ownerConfirmed !== "boolean") ||
              (input.approved !== undefined && typeof input.approved !== "boolean") ||
              Object.keys(input).some(key => !["confirmed", "ownerConfirmed", "approved", "targetId", "roomId", "participantId", "sessionId", "bindingId", "ttlMs", "maxPerMinute"].includes(key))) {
              writeJson(response, 400, { error: "invalid_wake_scope" }, cors);
              return;
            }
            const wakeTtlMs=input.ttlMs??300000;
            const wakeMaxPerMinute=input.maxPerMinute??6;
            if(!Number.isSafeInteger(wakeTtlMs)||wakeTtlMs<60000||wakeTtlMs>86400000||
               !Number.isSafeInteger(wakeMaxPerMinute)||wakeMaxPerMinute<1||wakeMaxPerMinute>6){
              writeJson(response,400,{error:"invalid_wake_scope"},cors);return;
            }
            const target = (await browser.listTargets()).find(item =>
              item.id === input.targetId && item.roomId === input.roomId && item.operations?.includes("wake") && item.wakeAvailable === true);
            if (!target) {
              writeJson(response, 409, { error: "canonical_wake_target_unavailable" }, cors);
              return;
            }
            const locallyApproved = await authorizeLocalAction({
              operation: "browser.wake.enable", targetId: target.id, pageId: target.pageId,
              roomId: input.roomId, participantId: input.participantId, sessionId: input.sessionId,
              bindingId: input.bindingId, site: target.site, title: target.title,
              capabilities: ["wake"], ttlMs: wakeTtlMs,
              maxPerMinute: wakeMaxPerMinute,
            });
            if (locallyApproved !== true) {
              writeJson(response, 403, { error: "trusted_local_browser_wake_approval_denied" }, cors);
              return;
            }
            const grant = await browser.enableContinuousWake({
              targetId: input.targetId, roomId: input.roomId, participantId: input.participantId,
              sessionId: input.sessionId, bindingId: input.bindingId, confirmed: true,
              ttlMs: wakeTtlMs, maxPerMinute: wakeMaxPerMinute,
            });
            if(wakeService){
              try {
                // The remote queue is enabled only after explicit, origin-bound
                // local approval, and only for this pre-enrolled binding.
                await wakeService.activateAndStart(grant,input);
              } catch {
                try { await wakeService.stop(input.bindingId); } catch {}
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
              typeof input.roomId !== "string" || !id.test(input.roomId) ||
              typeof input.bindingId !== "string" || !id.test(input.bindingId)) {
              writeJson(response, 400, { error: "invalid_wake_grant_scope" }, cors);
              return;
            }
            const revoked = await browser.revokeContinuousWake({ grantId: input.grantId, targetId: input.targetId, roomId: input.roomId });
            const stopStatus=revoked?await wakeService?.stop?.(input.bindingId):null;
            writeJson(response, revoked ? 200 : 404, {
              revoked,
              localPollingStopped:revoked,
              remoteDeactivationConfirmed:stopStatus?.remotelyDeactivated===true,
              remoteDeactivationPending:stopStatus?.remotelyDeactivated===false
            }, cors);
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
          const id = /^[a-f0-9-]{36}$/i;
          if (typeof input.targetId !== "string" || !id.test(input.targetId) ||
            typeof input.roomId !== "string" || !id.test(input.roomId) ||
            typeof input.text !== "string" || !input.text.trim() || input.text.length > 10000 ||
            Object.keys(input).some(key => !["approved", "targetId", "roomId", "text"].includes(key))) {
            writeJson(response, 400, { error: "invalid_target_or_draft_scope" }, cors);
            return;
          }
          const target = (await browser.listTargets()).find(item =>
            item.id === input.targetId && item.roomId === input.roomId && item.operations?.includes("draft"));
          if (!target) {
            writeJson(response, 404, { error: "browser_draft_target_unavailable" }, cors);
            return;
          }
          const locallyApproved = await authorizeLocalAction({
            operation: "browser.draft", targetId: target.id, pageId: target.pageId,
            roomId: input.roomId, site: target.site, title: target.title,
            capabilities: ["draft"], text: input.text,
          });
          if (locallyApproved !== true) {
            writeJson(response, 403, { error: "trusted_local_browser_draft_approval_denied" }, cors);
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
      let shutdownFailed = false;
      try { await wakeService?.stop?.(); } catch { shutdownFailed = true; }
      try { await multiSurfaceRuntime?.stop?.(); } catch { shutdownFailed = true; }
      let externalStop = null;
      try { externalStop = await externalWorkspaceRuntime?.stop?.() ?? null; if (externalStop && externalStop.closeFailures > 0) shutdownFailed = true; } catch { shutdownFailed = true; }
      const restartRequired = !!externalWorkspaceRuntime || shutdownFailed;
      writeJson(response, shutdownFailed ? 503 : 200, {
        revoked: true, runtimesStopped: !shutdownFailed,
        ...(externalWorkspaceRuntime ? { externalWorkspacesStopped: true } : {}),
        restartRequired,
        ...(shutdownFailed ? { error: "runtime_shutdown_incomplete" } : {}),
        ...(restartRequired ? { hint: shutdownFailed
          ? "This host session is revoked, but local runtime cleanup could not be verified. Stop the Backroom host process and inspect any remaining local sandbox before restarting."
          : "This host session is revoked. Local workspace adapters were stopped and cannot be reused until the Backroom host process is restarted." } : {}),
      }, cors);
      return;
    }
    const workspaceHandled = await handleWorkspaceHttpRequest({
      request, response, url, authority, workspaceRuntime: externalWorkspaceRuntime,
      corsHeaders: cors, writeJson, readJson,
    });
    if (workspaceHandled) return;
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
      try { const result = await externalWorkspaceRuntime?.stop?.(); if (result && result.closeFailures > 0) browserError = new Error("external_workspace_stop_failed"); } catch { browserError = new Error("external_workspace_stop_failed"); }
      try { await browser.stop(); } catch (error) { browserError = error; }
      if (server.listening) {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
      if (browserError) throw browserError;
    },
  };
}


const authorizeLocalWorkspaceAction = createSerializedLocalApproval(async action => {
  // A web page cannot manufacture this grant. Non-interactive hosts deny by default.
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return false;
  const { createInterface } = await import("node:readline/promises");
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write("\n\n[Rub Minds Backroom local approval]\n");
    process.stdout.write("This request originated from a local workspace adapter. Review every field before approving:\n");
    process.stdout.write(JSON.stringify(action, null, 2) + "\n");
    const isContinuousBrowserWake=action?.operation==="browser.wake.enable";
    if(isContinuousBrowserWake){
      process.stdout.write("WARNING: this enables automatic canonical wake submissions in one exact AI conversation. It can press that chat's Send control without a per-message prompt. Review the exact group, target, session, TTL and six-per-minute limit above.\n");
    }
    const approvalPhrase=isContinuousBrowserWake?"ENABLE AUTO":"APPROVE ONCE";
    const answer = await readline.question("Type "+approvalPhrase+" to permit only this exact operation and scope (anything else denies): ");
    return answer.trim() === approvalPhrase;
  } finally {
    readline.close();
  }
});
function csvAllowlist(name) {
  return (process.env[name] ?? "").split(",").map(value => value.trim()).filter(Boolean);
}
async function configureExternalWorkspaceRuntime(hostId) {
  const enableDesktop = process.env.BACKROOM_ENABLE_CUA_DRIVER === "1";
  const enableAndroid = process.env.BACKROOM_ENABLE_ARTEMIS === "1";
  const enableTerminal = process.env.BACKROOM_ENABLE_CUA_TERMINAL === "1";
  if (!enableDesktop && !enableAndroid && !enableTerminal) return null;
  const { McpStdioClient } = await import("../integrations/backroom/mcp-stdio-client.mjs");
  const { ArtemisAndroidWorkspace, CuaDesktopWorkspace, CuaSandboxTerminalWorkspace, createExternalWorkspaceService } =
    await import("../integrations/backroom/external-workspaces.mjs");
  const startupErrors = {};
  let desktop = null, android = null, terminal = null;
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    const message = "Interactive local TTY approval is unavailable; external workspace actions remain disabled.";
    if (enableDesktop) startupErrors.desktop = message;
    if (enableAndroid) startupErrors.android = message;
    if (enableTerminal) startupErrors.terminal = message;
    return createExternalWorkspaceService({ startupErrors });
  }
  async function isolateStartupFailure(name, operation, cleanup) {
    try { return await operation(); }
    catch (error) {
      startupErrors[name] = typeof error?.message === "string"
        ? error.message.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 180)
        : name + "_startup_failed";
      try { await cleanup?.(); } catch {}
      return null;
    }
  }
  if (enableDesktop) {
    let client = null;
    desktop = await isolateStartupFailure("desktop", async () => {
      client = new McpStdioClient({ command: process.env.BACKROOM_CUA_DRIVER_BIN ?? "cua-driver", args: ["mcp"] });
      await client.start();
      return new CuaDesktopWorkspace({ client, authorizeLocalAction: authorizeLocalWorkspaceAction });
    }, async () => client?.close());
  }
  if (enableAndroid) {
    let client = null;
    android = await isolateStartupFailure("android", async () => {
      const python = process.env.BACKROOM_ARTEMIS_PYTHON;
      const home = process.env.BACKROOM_ARTEMIS_HOME;
      const devices = csvAllowlist("BACKROOM_ARTEMIS_ALLOWED_DEVICE_SERIALS");
      const packages = csvAllowlist("BACKROOM_ARTEMIS_ALLOWED_PACKAGES");
      if (typeof python !== "string" || !python.trim() || typeof home !== "string" || !home.trim())
        throw new Error("ARTEMIS requires BACKROOM_ARTEMIS_PYTHON and BACKROOM_ARTEMIS_HOME");
      if (!devices.length || !packages.length)
        throw new Error("ARTEMIS needs nonempty host-local device serial and app package allowlists");
      client = new McpStdioClient({ command: python, args: ["-m", "mcp_server"], cwd: home, env: { PYTHONUNBUFFERED: "1", PYTHONPATH: home } });
      await client.start();
      return new ArtemisAndroidWorkspace({ client, allowedDevices: devices, allowedPackages: packages, authorizeLocalAction: authorizeLocalWorkspaceAction });
    }, async () => client?.close());
  }
  if (enableTerminal) {
    let instance = null;
    terminal = await isolateStartupFailure("terminal", async () => {
      const sandboxName = "rm-backroom-" + hostId.replace(/-/g, "").slice(0, 8);
      // Do not create a sandbox during host bootstrap: creation requires a selected
      // Backroom group/session and its own trusted local approval.
      instance = new CuaSandboxTerminalWorkspace({
        command: process.env.BACKROOM_CUA_CLI ?? "cua",
        sandboxName,
        authorizeLocalAction: authorizeLocalWorkspaceAction,
      });
      return instance;
    }, async () => instance?.close());
  }
  return createExternalWorkspaceService({ desktop, android, terminal, startupErrors });
}

export async function runBackroomHost() {
  const identityFilePath=join(homedir(), ".rub-minds", "backroom", "host-identity.json");
  const identity = await loadOrCreateHostIdentity({filePath:identityFilePath});
  const identityRotationPending=await isHostIdentityRotationPending({filePath:identityFilePath});
  const hostId = identity.hostId;
  const { BrowserHostRuntime } = await import("../integrations/backroom/browser-host-runtime.mjs");
  const browserRuntime = new BrowserHostRuntime({ hostId });
  const {createHostWakeService}=await import("../integrations/backroom/host-wake-service.mjs");
  const wakeService=createHostWakeService({
    identity,browserRuntime,
    journalDirectory:join(homedir(),".rub-minds","backroom","wake-execution-journal")
  });
  // A rotated host must never inherit the old identity's environment-bound input.
  // A local identity rotation must not inherit stale environment-bound input bindings.
  // The persistent marker stays until an operator explicitly reviews any headless configuration.
  const sessionDigest=identityRotationPending?undefined:process.env.BACKROOM_WAKE_SESSION_DIGEST;
  const bindingId=identityRotationPending?undefined:process.env.BACKROOM_WAKE_BINDING_ID;
  const publishableKey=identityRotationPending?undefined:process.env.BACKROOM_WAKE_PUBLISHABLE_KEY;
  const configured=[sessionDigest,bindingId,publishableKey].filter(Boolean).length;
  if(configured!==0&&configured!==3)
    throw new Error("Headless wake configuration requires session digest, binding ID and public project API key together");
  // The gateway origin is fixed in host-wake-service or trusted local process
  // configuration. The publishable key is public and cannot redirect the token.
  if(configured===3)wakeService.configure({sessionDigest,bindingId,publishableKey});
  const externalWorkspaceRuntime = await configureExternalWorkspaceRuntime(hostId);
  const instance = createBackroomHostServer({
    hostId,browserRuntime,enrollmentDigest:identity.credentialDigest,wakeService,externalWorkspaceRuntime,
    authorizeLocalAction: authorizeLocalWorkspaceAction
  });
  const address = await instance.start();
  process.stdout.write([
    "",
    "Rub Minds Backroom local host",
    `Address: http://${address.host}:${address.port}`,
    `Host ID: ${address.hostId}`,
    `Hosted enrollment digest: ${identity.credentialDigest}`,
    "Private host credential is stored only in the local host identity file (not printed).",
    "A persistent rotation marker prevents inherited headless wake configuration from reviving an old binding.",
    identityRotationPending
      ?"Remote wake: stale environment configuration suppressed after identity rotation. Reconfigure the new host explicitly from Rub Minds."
      :configured===3
        ?"Remote wake binding configured; awaiting explicit local grant."
        :"Remote wake: not configured. Pair the browser to configure a hosted binding without restarting.",
    `Allowed web origins: ${parseOrigins(process.env.BACKROOM_ALLOWED_ORIGINS).join(", ")}`,
    "Pairing code (one use, expires in 10 minutes):",
    instance.pairingCode,
    "External workspace runtimes are disabled by default. When enabled, desktop, Android and terminal actions require local TTY approval and host-local allowlists.",
    "Configured external workspace status: " + JSON.stringify(externalWorkspaceRuntime?.status?.() ?? { capabilities: { desktop: false, android: false, terminal: false } }),
    "The Backroom Emergency Stop closes the managed browser, revokes paired sessions and latches the host until this process is restarted.",
    "Keep this terminal private. Stop host with Ctrl+C.",
    "",
  ].join("\n"));
  const stop = async () => { await instance.close(); process.exitCode = 0; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return instance;
}

export async function rotateBackroomHostIdentity() {
  const identity=await rotateHostIdentity({
    filePath:join(homedir(),".rub-minds","backroom","host-identity.json")
  });
  process.stdout.write([
    "Rub Minds Backroom local host identity rotated.",
    "This only rotates the local file; it does NOT revoke the previous server registration.",
    "Before rotation, permanently revoke the previous host in the signed-in Rub Minds UI.",
    `New host ID: ${identity.hostId}`,
    `Hosted enrollment digest: ${identity.credentialDigest}`,
    "The private 256-bit host credential remains in the private local identity file.",
    "Start the host with: npm run backroom:host",
    "Register this new host from the signed-in Rub Minds UI. The prior revoked host stays revoked.",
    ""
  ].join("\n"));
  return Object.freeze({hostId:identity.hostId,credentialDigest:identity.credentialDigest});
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const rotateOnly=process.argv.includes("--rotate-identity-only");
  const action=rotateOnly ? rotateBackroomHostIdentity() :
    (process.argv.includes("--rotate-identity")
      ? Promise.reject(new Error("Use npm run backroom:rotate-host after revoking the previous host in Rub Minds."))
      : runBackroomHost());
  action.catch(error => {
    process.stderr.write(`Backroom host failed to start: ${error.message}\n`);
    process.exitCode = 1;
  });
}
