/**
 * Real Chromium smoke test against a local controlled AI-like composer.
 * No ChatGPT/Claude account, credentials, browser profile or external traffic.
 *
 * Run separately: npm run test:backroom:browser
 * Requires playwright browser installed or CHROMIUM_PATH executable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { chromium } from "playwright";
import { TargetRegistry } from "./target-registry.mjs";
import { BackroomDispatcher } from "./dispatcher.mjs";
import { LocalExecutionGuard } from "./host-runtime.mjs";
import { BrowserDraftAdapter } from "./browser-draft-adapter.mjs";

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Controlled AI composer</title></head>
<body><label for="prompt">Prompt</label><textarea id="prompt" data-composer></textarea><label for="rich">Rich prompt</label><div id="rich" contenteditable="true" role="textbox" aria-label="Rich prompt" style="width:520px;min-height:80px;border:1px solid #ccc;margin-top:20px;padding:10px"></div>
<button id="send">Send</button><output id="sent">0</output>
<script>document.getElementById("send").onclick=()=>{document.getElementById("sent").textContent=String(Number(document.getElementById("sent").textContent)+1)}</script>
</body></html>`;

test("controlled Chromium browser drafts an approved group prompt without sending", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/conversation/mock") {
      response.writeHead(200, {"content-type":"text/html; charset=utf-8", "cache-control":"no-store"});
      response.end(html);
    } else { response.writeHead(404); response.end(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let browser;
  try {
    const addr = server.address();
    const origin = "http://127.0.0.1:" + addr.port;
    browser = await chromium.launch({ headless:true,
      ...(process.env.CHROMIUM_PATH ? { executablePath:process.env.CHROMIUM_PATH } : {}) });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(origin + "/conversation/mock");
    const target = {
      id:"composer",roomId:"room",hostId:"local",spaceId:"web-ai",
      sessionId:"mock",appId:"controlled-ai",identityFingerprint:"controlled:mock",
      surface:"browser_tab",locatorKind:"dom",locatorValue:"[data-composer]",revision:1,
    };
    const registry = new TargetRegistry();
    registry.register(target);
    const adapter = new BrowserDraftAdapter({
      page, origin, path:"/conversation/mock",selector:"[data-composer]",
      appId:"controlled-ai",sessionId:"mock",identityFingerprint:"controlled:mock",
    });
    const host = new LocalExecutionGuard({
      host:{hostId:"local",deviceLabel:"Controlled local browser",surfaces:["browser_tab"],operations:["draft"]},
      adapter, permission:async()=>true, isConnected:async()=>true,
    });
    const dispatcher = new BackroomDispatcher({registry,adapter:host,authorize:async()=>true});
    const command = {
      id:"job",eventId:"message",roomId:"room",hostId:"local",
      spaceId:"web-ai",sessionId:"mock",identityFingerprint:"controlled:mock",
      targetId:"composer",targetRevision:1,operation:"draft",
      text:"@RMConnects: reply with a short research outline",
    };
    dispatcher.enqueue(command);
    assert.equal((await dispatcher.step("job")).state,"awaiting_approval");
    assert.equal(await page.locator("[data-composer]").inputValue(),"");
    assert.equal((await dispatcher.step("job",{approved:true})).state,"completed");
    assert.equal(await page.locator("[data-composer]").inputValue(),command.text);
    // Rich contenteditable AI composers must receive a browser editing event,
    // not only a raw textContent mutation that leaves the editor framework stale.
    const richTarget = { ...target, id:"rich-composer", locatorValue:"[contenteditable=true]" };
    const richAdapter = new BrowserDraftAdapter({
      page, origin, path:"/conversation/mock", selector:"[contenteditable=true]",
      appId:"controlled-ai", sessionId:"mock", identityFingerprint:"controlled:mock",
    });
    const richProbe = await richAdapter.probe({target:richTarget,operation:"draft"});
    assert.equal(richProbe.connected,true);
    const rich = await richAdapter.execute({command:{operation:"draft",text:"Rich editor draft"},target:richTarget});
    assert.equal(rich.state,"completed");
    assert.equal(await page.locator("#rich").textContent(),"Rich editor draft");
    assert.equal(await page.locator("#sent").textContent(),"0","rich editor drafting must never press Send");
    assert.equal((await dispatcher.step("job",{approved:true})).state,"completed");
    assert.equal(await page.locator("#sent").textContent(),"0");
    // A navigation makes the registered conversation stale.
    await page.goto(origin + "/invalid");
    assert.equal((await adapter.probe({target,operation:"draft"})).connected,false);
    await context.close();
  } finally {
    await browser?.close();
    await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
});
