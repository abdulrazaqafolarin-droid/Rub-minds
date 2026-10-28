import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { chromium } from "playwright";
import { installSelectionOverlay } from "./browser-host-runtime.mjs";

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:system-ui;margin:24px;background:white;color:#111}
textarea{display:block;margin-top:120px;width:480px;height:90px;padding:8px}
#notes{margin-top:28px}#send{margin-top:24px}
</style></head><body>
<h1>Local Backroom overlay test</h1>
<label for="prompt">Prompt</label><textarea id="prompt" aria-label="Prompt"></textarea>
<label for="notes">Notes</label><textarea id="notes" aria-label="Notes"></textarea>
<div id="readonly" role="textbox" aria-readonly="true" style="margin-top:24px;width:480px;height:50px;border:1px solid #ccc">Not editable</div><button id="send" type="button">Send</button><output id="count">0</output>
<script>document.querySelector('#send').addEventListener('click',()=>{document.querySelector('#count').textContent=String(Number(document.querySelector('#count').textContent)+1)})</script>
</body></html>`;
async function controlledPage(fn) {
 const server=createServer((request,response)=>{
  response.writeHead(request.url==="/test"?200:404,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"});
  response.end(request.url==="/test"?HTML:"not found");
 });
 server.listen(0,"127.0.0.1");await once(server,"listening");
 let browser;
 try {
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1000,height:900}});
  await page.goto("http://127.0.0.1:"+server.address().port+"/test");
  await fn(page);
 } finally {
  await browser?.close();
  await new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
 }
}
async function dragAround(page,selector) {
 const box=await page.locator(selector).boundingBox();
 assert.ok(box,"target input should have a visible bounding box");
 await page.mouse.move(box.x-8,box.y-8);
 await page.mouse.down();
 await page.mouse.move(box.x+box.width+8,box.y+box.height+8,{steps:5});
 await page.mouse.up();
}
test("drag overlay selects one real composer and returns a unique selector without sending",async()=>{
 await controlledPage(async page=>{
  await page.evaluate(installSelectionOverlay);
  await dragAround(page,"#prompt");
  const result=await page.evaluate(()=>window.__RM_BACKROOM_SELECTION_V1__);
  assert.equal(result.state,"selected");
  assert.match(result.selectionId,/^[a-f0-9-]{36}$/i,"selection must carry a fresh unguessable per-selection identifier");
  assert.equal(result.selector,'textarea[aria-label="Prompt"]');
  assert.equal(await page.locator("#count").textContent(),"0","selection must never click Send");
  assert.equal(await page.locator("#prompt").inputValue(),"","selection must not type into the composer");
 });
});
test("selection refuses a rectangle that encloses more than one editable input",async()=>{
 await controlledPage(async page=>{
  await page.evaluate(installSelectionOverlay);
  const a=await page.locator("#prompt").boundingBox(),b=await page.locator("#notes").boundingBox();
  await page.mouse.move(a.x-8,a.y-8);await page.mouse.down();
  await page.mouse.move(b.x+b.width+8,b.y+b.height+8,{steps:8});await page.mouse.up();
  const result=await page.evaluate(()=>window.__RM_BACKROOM_SELECTION_V1__);
  assert.equal(result.state,"failed");
  assert.match(result.message,/only one input/);
 });
});
test("restarting after a failed drag removes the old overlay listener and stale timer",async()=>{
 await controlledPage(async page=>{
  await page.evaluate(()=>{
   const listeners=new Set();
   const nativeAdd=window.addEventListener.bind(window);
   const nativeRemove=window.removeEventListener.bind(window);
   window.__backroomTestKeyListeners=listeners;
   window.addEventListener=function(type,listener,options){
    if(type==="keydown")listeners.add(listener);
    return nativeAdd(type,listener,options);
   };
   window.removeEventListener=function(type,listener,options){
    if(type==="keydown")listeners.delete(listener);
    return nativeRemove(type,listener,options);
   };
  });
  await page.evaluate(installSelectionOverlay);
  await page.mouse.move(12,220);await page.mouse.down();
  await page.mouse.move(14,222,{steps:1});await page.mouse.up();
  assert.equal((await page.evaluate(()=>window.__RM_BACKROOM_SELECTION_V1__)).state,"failed");
  await page.evaluate(installSelectionOverlay);
  assert.equal(await page.evaluate(()=>window.__backroomTestKeyListeners.size),1,
   "only the latest overlay should own a keydown listener");
  await dragAround(page,"#prompt");
  assert.equal((await page.evaluate(()=>window.__RM_BACKROOM_SELECTION_V1__)).state,"selected");
  await page.waitForTimeout(1300);
  assert.equal((await page.evaluate(()=>window.__RM_BACKROOM_SELECTION_V1__)).state,"selected",
   "a stale failure timer must not replace a later successful selection");
  assert.equal(await page.evaluate(()=>window.__backroomTestKeyListeners.size),0,
   "a completed selection must remove its keyboard listener");
  assert.equal(await page.locator("#count").textContent(),"0");
 });
});

test("Escape cancels the overlay without changing the active input",async()=>{
 await controlledPage(async page=>{
  await page.evaluate(installSelectionOverlay);
  await page.keyboard.press("Escape");
  const result=await page.evaluate(()=>window.__RM_BACKROOM_SELECTION_V1__);
  assert.equal(result.state,"cancelled");
  assert.equal(await page.locator("#count").textContent(),"0");
 });
});

test("readonly ARIA textboxes are not registered as writable",async()=>{
 await controlledPage(async page=>{
  await page.evaluate(installSelectionOverlay);
  await dragAround(page,"#readonly");
  const result=await page.evaluate(()=>window.__RM_BACKROOM_SELECTION_V1__);
  assert.equal(result.state,"failed");
  assert.match(result.message,/No editable input/);
 });
});
