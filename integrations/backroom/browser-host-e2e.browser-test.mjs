import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { BrowserHostRuntime } from "./browser-host-runtime.mjs";
import { createBackroomHostServer } from "../../scripts/backroom-host-server.mjs";

const ROOM_ID = "12345678-1234-4234-9234-123456789014";
const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Local controlled AI composer</title>
<style>body{font:16px system-ui;margin:32px}textarea{display:block;width:520px;height:100px;margin-top:18px;padding:10px}button{margin-top:18px}</style></head>
<body><h1>Controlled composer</h1><label for="prompt">AI prompt</label><textarea id="prompt" aria-label="AI prompt"></textarea>
<button id="send" type="button">Send</button><output id="sent-count">0</output>
<script>document.querySelector('#send').addEventListener('click',()=>document.querySelector('#sent-count').textContent=String(Number(document.querySelector('#sent-count').textContent)+1))</script>
</body></html>`;

async function startPageServer() {
 const server=createServer((request,response)=>{
  if(request.url==="/chat"||request.url==="/"){
   response.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"});
   response.end(HTML);
  } else {response.writeHead(404);response.end("not found");}
 });
 server.listen(0,"127.0.0.1");await once(server,"listening");
 return {server,origin:"http://127.0.0.1:"+server.address().port,
  close:()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))};
}
async function requestJson(base,origin,path,{method="GET",token,body}={}) {
 const headers={Origin:origin};
 if(token)headers.Authorization="Bearer "+token;
 if(body!==undefined)headers["Content-Type"]="application/json";
 const response=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
 return {response,body:await response.json().catch(()=>({}))};
}

test("real local host -> Playwright browser overlay -> group-scoped target -> verified draft, never send",async t=>{
 const fixture=await startPageServer();
 const profileDir=await mkdtemp(join(tmpdir(),"rub-backroom-e2e-"));
 let realContext=null;
 const browserRuntime=new BrowserHostRuntime({
  hostId:"e2e-backroom-host",profileDir,headless:true,
  chromiumProvider:async()=>({launchPersistentContext:async(dir,options)=>{
   realContext=await chromium.launchPersistentContext(dir,options);
   return realContext;
  }}),
 });
 const host=createBackroomHostServer({port:0,allowedOrigins:[fixture.origin],hostId:"e2e-backroom-host",
  pairingCode:"ab".repeat(16),browserRuntime});
 let hostBase="";
 try {
  const address=await host.start();hostBase="http://127.0.0.1:"+address.port;
  const paired=await requestJson(hostBase,fixture.origin,"/v1/pair",{method:"POST",body:{pairingCode:host.pairingCode,clientLabel:"E2E test"}});
  assert.equal(paired.response.status,200);
  const token=paired.body.sessionToken;
  const started=await requestJson(hostBase,fixture.origin,"/v1/browser/start",{method:"POST",token});
  assert.equal(started.response.status,200);
  assert.equal(started.body.running,true);
  const opened=await requestJson(hostBase,fixture.origin,"/v1/browser/open",{method:"POST",token,body:{url:fixture.origin+"/chat"}});
  assert.equal(opened.response.status,200);
  assert.equal(opened.body.site,"127.0.0.1");
  const pageId=opened.body.pageId;
  const page=realContext.pages().find(p=>p.url()===fixture.origin+"/chat");
  assert.ok(page,"managed Playwright page should open the controlled chat page");
  const select=await requestJson(hostBase,fixture.origin,"/v1/browser/select",{method:"POST",token,body:{pageId,roomId:ROOM_ID}});
  assert.equal(select.response.status,200);
  const box=await page.locator("#prompt").boundingBox();
  assert.ok(box,"composer should be visible to the selection overlay");
  await page.mouse.move(box.x-8,box.y-8);
  await page.mouse.down();
  await page.mouse.move(box.x+box.width+8,box.y+box.height+8,{steps:6});
  await page.mouse.up();
  const selected=await requestJson(hostBase,fixture.origin,"/v1/browser/selection/"+pageId,{token});
  assert.equal(selected.response.status,200);
  assert.equal(selected.body.state,"selected");
  assert.equal(selected.body.ariaLabel,"AI prompt");
  const registered=await requestJson(hostBase,fixture.origin,"/v1/browser/targets",{method:"POST",token,body:{pageId,roomId:ROOM_ID}});
  assert.equal(registered.response.status,201);
  assert.equal(registered.body.submittedAutomatically,false);
  const exactText="@RMConnects: please review the group's latest task. Do not send automatically.";
  const drafted=await requestJson(hostBase,fixture.origin,"/v1/browser/draft",{method:"POST",token,
   body:{targetId:registered.body.id,roomId:ROOM_ID,text:exactText,approved:true}});
  assert.equal(drafted.response.status,200);
  assert.equal(drafted.body.state,"completed");
  assert.equal(drafted.body.submitted,false);
  assert.equal(await page.locator("#prompt").inputValue(),exactText);
  assert.equal(await page.locator("#sent-count").textContent(),"0","the Send button must remain untouched");
  // An occupied input must never be overwritten by a repeated task.
  const repeat=await requestJson(hostBase,fixture.origin,"/v1/browser/draft",{method:"POST",token,
   body:{targetId:registered.body.id,roomId:ROOM_ID,text:"replacement text",approved:true}});
  assert.equal(repeat.response.status,409);
  assert.equal(await page.locator("#prompt").inputValue(),exactText);
  assert.equal(await page.locator("#sent-count").textContent(),"0");
  // A target from one group cannot be invoked as another group.
  const crossRoom=await requestJson(hostBase,fixture.origin,"/v1/browser/draft",{method:"POST",token,
   body:{targetId:registered.body.id,roomId:"22345678-1234-4234-9234-123456789014",text:"cross-group",approved:true}});
  assert.notEqual(crossRoom.response.status,200);
  assert.equal(await page.locator("#prompt").inputValue(),exactText);
  const unpaired=await requestJson(hostBase,fixture.origin,"/v1/unpair",{method:"POST",token});
  assert.equal(unpaired.response.status,200);
  const denied=await requestJson(hostBase,fixture.origin,"/v1/browser/pages",{token});
  assert.equal(denied.response.status,401);
 } finally {
  await host.close().catch(()=>{});
  await fixture.close().catch(()=>{});
  await rm(profileDir,{recursive:true,force:true}).catch(()=>{});
 }
});
