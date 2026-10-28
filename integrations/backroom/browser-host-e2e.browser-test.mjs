import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { BrowserHostRuntime } from "./browser-host-runtime.mjs";
import { BrowserDraftAdapter } from "./browser-draft-adapter.mjs";
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
  // A webpage can copy a public DOM attribute to another composer. The
  // host must confirm marker ownership against the exact selected ElementHandle.
  const originalMarker=await page.locator("#prompt").getAttribute("data-rm-backroom-binding");
  assert.ok(originalMarker,"the first target should own a DOM binding marker");
  await page.evaluate(() => {
   const original=document.querySelector("#prompt");
   const clone=original.cloneNode(true);
   clone.id="prompt-copy";
   clone.setAttribute("aria-label","Alternate prompt");
   clone.value="";
   original.parentElement.append(clone);
  });
  assert.equal(await page.locator("#prompt-copy").getAttribute("data-rm-backroom-binding"),originalMarker,
   "fixture deliberately copies the original marker onto another writable input");
  const roomTwo="22345678-1234-4234-9234-123456789014";
  const selectCopy=await requestJson(hostBase,fixture.origin,"/v1/browser/select",{
   method:"POST",token,body:{pageId,roomId:roomTwo}
  });
  assert.equal(selectCopy.response.status,200);
  const cloneBox=await page.locator("#prompt-copy").boundingBox();
  assert.ok(cloneBox,"copied composer should be visible");
  await page.mouse.move(cloneBox.x-8,cloneBox.y-8);
  await page.mouse.down();
  await page.mouse.move(cloneBox.x+cloneBox.width+8,cloneBox.y+cloneBox.height+8,{steps:6});
  await page.mouse.up();
  const selectedCopy=await requestJson(hostBase,fixture.origin,"/v1/browser/selection/"+pageId,{token});
  assert.equal(selectedCopy.body.state,"selected");
  assert.equal(selectedCopy.body.ariaLabel,"Alternate prompt");
  const registeredCopy=await requestJson(hostBase,fixture.origin,"/v1/browser/targets",{
   method:"POST",token,body:{pageId,roomId:roomTwo}
  });
  assert.equal(registeredCopy.response.status,201);
  assert.notEqual(registeredCopy.body.id,registered.body.id);
  const replacementMarker=await page.locator("#prompt-copy").getAttribute("data-rm-backroom-binding");
  assert.ok(replacementMarker);
  assert.notEqual(replacementMarker,originalMarker,"a copied marker cannot claim the original target's identity");
  assert.equal(await page.locator("#prompt").getAttribute("data-rm-backroom-binding"),originalMarker,
   "the original target marker should remain attached to its original node");
  const roomTwoDraft=await requestJson(hostBase,fixture.origin,"/v1/browser/draft",{method:"POST",token,
   body:{targetId:registeredCopy.body.id,roomId:roomTwo,text:"Independent room two draft",approved:true}});
  assert.equal(roomTwoDraft.response.status,200);
  assert.equal(roomTwoDraft.body.submitted,false);
  assert.equal(await page.locator("#prompt-copy").inputValue(),"Independent room two draft");
  assert.equal(await page.locator("#prompt").inputValue(),exactText);
  assert.equal(await page.locator("#sent-count").textContent(),"0","copied-marker test must never click Send");
  // Simulate a SPA changing the active conversation after adapter preflight but
  // before the write task executes. The route check must be inside that same
  // synchronous page task, not only in the earlier locator probe.
  const racePage=await realContext.newPage();
  await racePage.goto(fixture.origin+"/chat");
  const originalHandle=await racePage.locator("#prompt").elementHandle();
  assert.ok(originalHandle,"race-test composer should have a retained element handle");
  let routeChangedAtInsertion=false;
  const racingHandle={
   evaluate:async(fn,arg)=>{
    if(!routeChangedAtInsertion && String(fn).includes("current.origin !== request.origin")){
     routeChangedAtInsertion=true;
     await racePage.evaluate(()=>history.replaceState({}, "", "/other-conversation"));
    }
    return originalHandle.evaluate(fn,arg);
   },
   dispose:()=>originalHandle.dispose(),
  };
  const raceAdapter=new BrowserDraftAdapter({
   page:racePage,origin:fixture.origin,path:"/chat",selector:"#prompt",
   appId:fixture.origin,sessionId:"race-session",identityFingerprint:"race-conversation",
   nodeHandle:racingHandle,
  });
  const raceTarget={
   surface:"browser_tab",locatorKind:"dom",locatorValue:"#prompt",appId:fixture.origin,
   sessionId:"race-session",identityFingerprint:"race-conversation",
  };
  await assert.rejects(()=>raceAdapter.execute({
   command:{operation:"draft",text:"must not cross a conversation"},target:raceTarget,
  }),/conversation changed.*draft insertion/i);
  assert.equal(routeChangedAtInsertion,true,"race must occur after #field preflight");
  assert.equal(await racePage.locator("#prompt").inputValue(),"","stale conversation must remain untouched");
  await originalHandle.dispose();

  // Focus itself can run site code. If that code changes the route, abort
  // before writing rather than trusting the earlier adapter preflight.
  const focusRoutePage=await realContext.newPage();
  await focusRoutePage.goto(fixture.origin+"/chat");
  await focusRoutePage.evaluate(()=>{
   document.querySelector("#prompt").addEventListener("focus",()=>{
    history.replaceState({}, "", "/focus-changed-conversation");
   });
  });
  const focusRouteHandle=await focusRoutePage.locator("#prompt").elementHandle();
  const focusRouteAdapter=new BrowserDraftAdapter({
   page:focusRoutePage,origin:fixture.origin,path:"/chat",selector:"#prompt",
   appId:fixture.origin,sessionId:"focus-route",identityFingerprint:"focus-route-conversation",
   nodeHandle:focusRouteHandle,
  });
  await assert.rejects(()=>focusRouteAdapter.execute({
   command:{operation:"draft",text:"must not cross a focus-triggered route"},target:{
    surface:"browser_tab",locatorKind:"dom",locatorValue:"#prompt",appId:fixture.origin,
    sessionId:"focus-route",identityFingerprint:"focus-route-conversation",
   }
  }),/conversation changed.*draft insertion/i);
  assert.equal(await focusRoutePage.locator("#prompt").inputValue(),"","focus-triggered navigation must not receive text");
  await focusRouteHandle.dispose();

  // Focus handlers can also populate a field. The adapter must check emptiness
  // again after focus so that newly appeared text is never overwritten.
  const focusFillPage=await realContext.newPage();
  await focusFillPage.goto(fixture.origin+"/chat");
  await focusFillPage.evaluate(()=>{
   document.querySelector("#prompt").addEventListener("focus",()=>{
    document.querySelector("#prompt").value="site inserted text on focus";
   });
  });
  const focusFillHandle=await focusFillPage.locator("#prompt").elementHandle();
  const focusFillAdapter=new BrowserDraftAdapter({
   page:focusFillPage,origin:fixture.origin,path:"/chat",selector:"#prompt",
   appId:fixture.origin,sessionId:"focus-fill",identityFingerprint:"focus-fill-conversation",
   nodeHandle:focusFillHandle,
  });
  await assert.rejects(()=>focusFillAdapter.execute({
   command:{operation:"draft",text:"must not overwrite a value added on focus"},target:{
    surface:"browser_tab",locatorKind:"dom",locatorValue:"#prompt",appId:fixture.origin,
    sessionId:"focus-fill",identityFingerprint:"focus-fill-conversation",
   }
  }),/existing draft cannot be overwritten/i);
  assert.equal(await focusFillPage.locator("#prompt").inputValue(),"site inserted text on focus");
  await focusFillHandle.dispose();

  // A focus handler could mutate an ordinary input into a password field
  // after preflight. Revalidate type and visibility before changing any value.
  const typeRacePage=await realContext.newPage();
  await typeRacePage.goto(fixture.origin+"/chat");
  await typeRacePage.evaluate(()=>{
   const field=document.createElement("input");
   field.id="type-race";field.type="text";field.style.cssText="display:block;width:320px;height:48px;margin-top:24px";
   document.body.append(field);
   field.addEventListener("focus",()=>{field.type="password";});
  });
  const typeRaceHandle=await typeRacePage.locator("#type-race").elementHandle();
  const typeRaceAdapter=new BrowserDraftAdapter({
   page:typeRacePage,origin:fixture.origin,path:"/chat",selector:"#type-race",
   appId:fixture.origin,sessionId:"type-race",identityFingerprint:"type-race-conversation",
   nodeHandle:typeRaceHandle,
  });
  await assert.rejects(()=>typeRaceAdapter.execute({
   command:{operation:"draft",text:"must not be written to a password field"},target:{
    surface:"browser_tab",locatorKind:"dom",locatorValue:"#type-race",appId:fixture.origin,
    sessionId:"type-race",identityFingerprint:"type-race-conversation",
   }
  }),/composer is no longer editable/i);
  assert.equal(await typeRacePage.locator("#type-race").inputValue(),"");
  assert.equal(await typeRacePage.locator("#type-race").getAttribute("type"),"password",
   "test must actually mutate the field type after focus");
  await typeRaceHandle.dispose();

  // A site's focus handler can enqueue a microtask that populates a field.
  // The adapter should yield to those microtasks and recheck the value atomically.
  const microtaskPage=await realContext.newPage();
  await microtaskPage.goto(fixture.origin+"/chat");
  await microtaskPage.evaluate(()=>{
   const field=document.createElement("input");
   field.id="microtask-race";field.type="text";field.style.cssText="display:block;width:320px;height:48px;margin-top:24px";
   document.body.append(field);
   field.addEventListener("focus",()=>queueMicrotask(()=>{field.value="value appeared in focus microtask";}));
  });
  const microtaskHandle=await microtaskPage.locator("#microtask-race").elementHandle();
  const microtaskAdapter=new BrowserDraftAdapter({
   page:microtaskPage,origin:fixture.origin,path:"/chat",selector:"#microtask-race",
   appId:fixture.origin,sessionId:"microtask-race",identityFingerprint:"microtask-race-conversation",
   nodeHandle:microtaskHandle,
  });
  await assert.rejects(()=>microtaskAdapter.execute({
   command:{operation:"draft",text:"must not overwrite the microtask value"},target:{
    surface:"browser_tab",locatorKind:"dom",locatorValue:"#microtask-race",appId:fixture.origin,
    sessionId:"microtask-race",identityFingerprint:"microtask-race-conversation",
   }
  }),/existing draft cannot be overwritten/i);
  assert.equal(await microtaskPage.locator("#microtask-race").inputValue(),"value appeared in focus microtask");
  await microtaskHandle.dispose();

  // A room change/cancel must remove the active overlay, its keyboard listener
  // and its selected-element reference without removing previously registered targets.
  const cancelRoom="32345678-1234-4234-9234-123456789014";
  const pendingSelection=await requestJson(hostBase,fixture.origin,"/v1/browser/select",{
   method:"POST",token,body:{pageId,roomId:cancelRoom}
  });
  assert.equal(pendingSelection.response.status,200);
  assert.equal(pendingSelection.body.state,"pending");
  assert.match(pendingSelection.body.selectionAttemptId,/^[a-f0-9-]{36}$/i);
  assert.equal(await page.locator("#__rm_backroom_target_overlay_v1").count(),1);
  const staleCancel=await requestJson(hostBase,fixture.origin,"/v1/browser/select/cancel",{
   method:"POST",token,body:{pageId,roomId:cancelRoom,attemptId:"42345678-1234-4234-9234-123456789099"}
  });
  assert.equal(staleCancel.response.status,200);
  assert.equal(staleCancel.body.cancelled,false);
  assert.equal(await page.locator("#__rm_backroom_target_overlay_v1").count(),1,
   "a mismatched attempt ID must not remove the active overlay");
  const cancelledSelection=await requestJson(hostBase,fixture.origin,"/v1/browser/select/cancel",{
   method:"POST",token,body:{pageId,roomId:cancelRoom,attemptId:pendingSelection.body.selectionAttemptId}
  });
  assert.equal(cancelledSelection.response.status,200);
  assert.equal(cancelledSelection.body.cancelled,true);
  assert.deepEqual(await page.evaluate(()=>({
   overlay:!!document.getElementById("__rm_backroom_target_overlay_v1"),
   selectionPresent:!!window.__RM_BACKROOM_SELECTION_V1__,
   selectedElementPresent:!!window.__RM_BACKROOM_SELECTED_ELEMENT_V1__,
   cleanupPresent:typeof window.__RM_BACKROOM_SELECTION_CLEANUP_V1__==="function",
   activeAttempt:window.__RM_BACKROOM_ACTIVE_SELECTION_ATTEMPT_V1__??null,
  })),{
   overlay:false,selectionPresent:false,selectedElementPresent:false,cleanupPresent:false,activeAttempt:null,
  });
  const existingTargets=await requestJson(hostBase,fixture.origin,"/v1/browser/targets",{token});
  assert.ok(existingTargets.body.targets.some(target=>target.id===registered.body.id));
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
