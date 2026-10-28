import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import {createBackroomHostServer} from "../../scripts/backroom-host-server.mjs";

async function withHost(fn, options={}) {
  const host=createBackroomHostServer({port:0,allowedOrigins:["https://rub-minds.vercel.app","http://localhost:5173"],pairingCode:"ab".repeat(16),hostId:"host-test",...options});
  const {port}=await host.start();
  try { await fn({host,base:"http://127.0.0.1:"+port,origin:"https://rub-minds.vercel.app"}); }
  finally { await host.close(); }
}
async function pair(base,origin,code="ab".repeat(16)) {
 return fetch(base+"/v1/pair",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({pairingCode:code,clientLabel:"Test browser"})});
}
test("host binds loopback and refuses wildcard origins",async()=>{
 assert.throws(()=>createBackroomHostServer({host:"0.0.0.0",allowedOrigins:["https://rub-minds.vercel.app"]}),/loopback/);
 assert.throws(()=>createBackroomHostServer({allowedOrigins:["*"]}),/exact/);
});
test("one-time pairing yields origin-bound scoped status and no execution capabilities",async()=>{
 await withHost(async({base,origin})=>{
  const result=await pair(base,origin);assert.equal(result.status,200);
  const credentials=await result.json();assert.equal(credentials.hostId,"host-test");assert.match(credentials.sessionToken,/^[a-f0-9]{64}$/);
  const info=await fetch(base+"/v1/host",{headers:{Origin:origin,Authorization:"Bearer "+credentials.sessionToken}});
  assert.equal(info.status,200);const data=await info.json();assert.equal(data.connected,true);assert.equal(data.executionReady,false);
  assert.equal(Object.values(data.capabilities).some(Boolean),false);
  assert.equal((await pair(base,origin)).status,401);
 });
});
test("pairing rejects wrong code, wrong origin and replays",async()=>{
 await withHost(async({base,origin})=>{
  assert.equal((await pair(base,origin,"cd".repeat(16))).status,401);
  assert.equal((await pair(base,"http://evil.test")).status,403);
  assert.equal((await pair(base,origin)).status,200);
  assert.equal((await pair(base,origin)).status,401);
 });
});
test("bearer token is bound to exact origin and revocation takes effect",async()=>{
 await withHost(async({base,origin})=>{
  const c=await (await pair(base,origin)).json();
  assert.equal((await fetch(base+"/v1/host",{headers:{Origin:"http://localhost:5173",Authorization:"Bearer "+c.sessionToken}})).status,401);
  assert.equal((await fetch(base+"/v1/unpair",{method:"POST",headers:{Origin:origin,Authorization:"Bearer "+c.sessionToken}})).status,200);
  assert.equal((await fetch(base+"/v1/host",{headers:{Origin:origin,Authorization:"Bearer "+c.sessionToken}})).status,401);
 });
});
test("loopback host-header validation blocks DNS-rebinding style requests",async()=>{
 await withHost(async({base,origin})=>{
  const good=await fetch(base+"/health",{headers:{Origin:origin}});
  assert.equal(good.status,200);
  const port=new URL(base).port;
  // Node fetch/undici owns the Host header, so use node:http to verify that
  // the server rejects a hostile Host value rather than silently normalizing it.
  const requestWithHost = hostHeader => new Promise((resolve,reject) => {
   const req=httpRequest(new URL("/health",base),{headers:{Origin:origin,Host:hostHeader}},response=>{
    const chunks=[];
    response.on("data",chunk=>chunks.push(chunk));
    response.on("end",()=>resolve({status:response.statusCode,body:Buffer.concat(chunks).toString("utf8")}));
   });
   req.on("error",reject);
   req.end();
  });
  const rebinding=await requestWithHost("attacker.example:"+port);
  assert.equal(rebinding.status,403);
  assert.equal(JSON.parse(rebinding.body).error,"invalid_host_header");
  const wrongLoopback=await requestWithHost("127.0.0.1:1");
  assert.equal(wrongLoopback.status,403);
 });
});

test("CORS preflight is exact-origin and does not rely on deprecated PNA headers", async () => {
 await withHost(async ({base,origin}) => {
  const good=await fetch(base+"/v1/host", {method:"OPTIONS", headers:{
    Origin:origin, "Access-Control-Request-Method":"GET",
    "Access-Control-Request-Headers":"authorization,content-type"
  }});
  assert.equal(good.status,204);
  assert.equal(good.headers.get("access-control-allow-origin"),origin);
  assert.match(good.headers.get("access-control-allow-methods") || "",/GET/);
  assert.equal(good.headers.get("access-control-allow-headers"),"Authorization, Content-Type");
  assert.equal(good.headers.get("access-control-allow-private-network"),null);
  const bad=await fetch(base+"/v1/host",{method:"OPTIONS",headers:{Origin:"https://evil.test"}});
  assert.equal(bad.status,403);
 });
});
test("expired pairing codes cannot be redeemed", async () => {
 let now = 1000;
 const host = createBackroomHostServer({ port:0, allowedOrigins:["https://rub-minds.vercel.app"],
   pairingCode:"ab".repeat(16), now:()=>now, pairingTtlMs:1000 });
 const {port} = await host.start();
 try {
   now = 2000;
   assert.equal((await pair("http://127.0.0.1:"+port, "https://rub-minds.vercel.app")).status, 401);
 } finally { await host.close(); }
});
test("health endpoint is no-store and query strings are rejected",async()=>{
 await withHost(async({base,origin})=>{
  const healthy=await fetch(base+"/health",{headers:{Origin:origin}});
  assert.equal(healthy.status,200);assert.equal(healthy.headers.get("cache-control"),"no-store, max-age=0");
  assert.equal((await fetch(base+"/health?token=oops",{headers:{Origin:origin}})).status,400);
 });
});

function fakeBrowserRuntime() {
 let running=false, selected=null, selectionRoom=null, selectionAttemptId=null, selectionCounter=0, targets=[];
 const pageId="12345678-1234-4234-9234-123456789012";
 const targetId="12345678-1234-4234-9234-123456789013";
 const makeSelectionAttempt=()=> "32345678-1234-4234-9234-"+String(++selectionCounter).padStart(12,"0");
 const status=()=>({running,pages:running?1:0,capabilities:{browserDraft:running,desktopAccessibility:false,androidAccessibility:false,terminal:false}});
 return {
  status,
  start:async()=>{running=true;return status()},
  openUrl:async url=>({pageId,title:"Test chat",site:new URL(url).hostname,canSelect:true}),
  stop:async()=>{running=false;targets=[];return status()},
  listPages:async()=>running?[{pageId,title:"Test chat",site:"chatgpt.com",canSelect:true}]:[],
  startSelection:async(id,roomId)=>{if(id!==pageId)throw Error("page not found");selectionRoom=roomId;selectionAttemptId=makeSelectionAttempt();selected={state:"pending",selectionAttemptId};return selected},
  cancelSelection:async(id,roomId,attemptId)=>{if(id!==pageId||roomId!==selectionRoom||attemptId!==selectionAttemptId||!selected)return false;selectionRoom=null;selectionAttemptId=null;selected=null;return true},
  getSelection:async(id,attemptId)=>({state:id===pageId&&selected?.selectionAttemptId===attemptId?selected?.state||"unavailable":"cancelled"}),
  registerSelectedTarget:async(id,roomId,attemptId)=>{if(id!==pageId||selected?.state!=="selected"||roomId!==selectionRoom||attemptId!==selectionAttemptId)throw Error("selection missing, replaced or wrong room");const t={id:targetId,pageId,roomId,title:"Test chat",site:"chatgpt.com",surface:"browser_tab",operations:["draft"]};targets.push(t);return t},
  listTargets:async()=>targets,
  unregisterTarget:async(id,roomId)=>{const index=targets.findIndex(t=>t.id===id&&t.roomId===roomId);if(index<0)return false;targets.splice(index,1);return true},
  draft:async(id,text,{approved,roomId}={})=>{if(approved!==true)throw Error("approval required");if(!targets.some(t=>t.id===id&&t.roomId===roomId)){const error=Error("target scope mismatch");error.status=409;throw error}return {state:"completed",result:{drafted:true,submitted:false},submitted:false}},
  testSetSelected:()=>{selected={state:"selected",selectionAttemptId};},
  pageId,targetId,
 };
}
test("browser control routes require host pairing and expose truthful capability status",async()=>{
 const browserRuntime=fakeBrowserRuntime();
 await withHost(async({base,origin,host})=>{
  const pairResult=await pair(base,origin);const credentials=await pairResult.json();const auth={Origin:origin,Authorization:"Bearer "+credentials.sessionToken};
  assert.equal((await fetch(base+"/v1/browser/pages",{headers:{Origin:origin}})).status,401);
  assert.equal((await fetch(base+"/v1/browser/start",{method:"POST",headers:auth})).status,200);
  const hostStatus=await (await fetch(base+"/v1/host",{headers:auth})).json();
  assert.equal(hostStatus.capabilities.browserDraft,true);assert.equal(hostStatus.capabilities.androidAccessibility,false);
  const opened=await fetch(base+"/v1/browser/open",{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify({url:"https://chatgpt.com/"})});
  assert.equal(opened.status,200);
  assert.equal((await opened.json()).site,"chatgpt.com");
  const pages=await (await fetch(base+"/v1/browser/pages",{headers:auth})).json();
  assert.equal(pages.pages[0].site,"chatgpt.com");
  const selectResponse=await fetch(base+"/v1/browser/select",{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify({pageId:browserRuntime.pageId,roomId:"12345678-1234-4234-9234-123456789014"})});
  assert.equal(selectResponse.status,200);
  const selectionAttemptId=(await selectResponse.json()).selectionAttemptId;
  assert.match(selectionAttemptId,/^[a-f0-9-]{36}$/i);
  browserRuntime.testSetSelected();
  assert.equal((await fetch(base+"/v1/browser/targets",{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify({pageId:browserRuntime.pageId,roomId:"12345678-1234-4234-9234-123456789014",attemptId:selectionAttemptId})})).status,201);
  const draft=await fetch(base+"/v1/browser/draft",{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify({targetId:browserRuntime.targetId,roomId:"12345678-1234-4234-9234-123456789014",text:"draft only",approved:true})});
  assert.equal(draft.status,200);assert.equal((await draft.json()).submitted,false);
  const wrongGroup=await fetch(base+"/v1/browser/draft",{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify({targetId:browserRuntime.targetId,roomId:"12345678-1234-4234-9234-123456789099",text:"wrong room",approved:true})});
  assert.equal(wrongGroup.status,409);
  assert.equal((await fetch(base+"/v1/unpair",{method:"POST",headers:auth})).status,200);
  assert.equal((await fetch(base+"/v1/browser/pages",{headers:auth})).status,401);
 },{browserRuntime});
});
test("browser drafting endpoint requires explicit approval and JSON content type",async()=>{
 const browserRuntime=fakeBrowserRuntime();
 await withHost(async({base,origin})=>{
  const creds=await (await pair(base,origin)).json();const auth={Origin:origin,Authorization:"Bearer "+creds.sessionToken};
  await fetch(base+"/v1/browser/start",{method:"POST",headers:auth});
  const selected=await fetch(base+"/v1/browser/select",{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify({pageId:browserRuntime.pageId,roomId:"12345678-1234-4234-9234-123456789014"})});
  const selectionAttemptId=(await selected.json()).selectionAttemptId;
  browserRuntime.testSetSelected();
  await fetch(base+"/v1/browser/targets",{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify({pageId:browserRuntime.pageId,roomId:"12345678-1234-4234-9234-123456789014",attemptId:selectionAttemptId})});
  const noApproval=await fetch(base+"/v1/browser/draft",{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify({targetId:browserRuntime.targetId,roomId:"12345678-1234-4234-9234-123456789014",text:"text",approved:false})});
  assert.equal(noApproval.status,403);
  const noJson=await fetch(base+"/v1/browser/select",{method:"POST",headers:auth,body:"{}"});
  assert.equal(noJson.status,415);
 },{browserRuntime});
});

test("selection cancellation requires the paired host and matching group",async()=>{
 const browserRuntime=fakeBrowserRuntime();
 await withHost(async({base,origin})=>{
  const credentials=await (await pair(base,origin)).json();
  const auth={Origin:origin,Authorization:"Bearer "+credentials.sessionToken};
  const roomId="12345678-1234-4234-9234-123456789014";
  await fetch(base+"/v1/browser/start",{method:"POST",headers:auth});
  const select=await fetch(base+"/v1/browser/select",{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify({pageId:browserRuntime.pageId,roomId})});
  assert.equal(select.status,200);
  const selection=await select.json();
  assert.match(selection.selectionAttemptId,/^[a-f0-9-]{36}$/i);
  const wrongRoom=await fetch(base+"/v1/browser/select/cancel",{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify({pageId:browserRuntime.pageId,roomId:"22345678-1234-4234-9234-123456789014",attemptId:selection.selectionAttemptId})});
  assert.equal(wrongRoom.status,200);
  assert.equal((await wrongRoom.json()).cancelled,false);
  const wrongAttempt=await fetch(base+"/v1/browser/select/cancel",{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify({pageId:browserRuntime.pageId,roomId,attemptId:"42345678-1234-4234-9234-123456789099"})});
  assert.equal(wrongAttempt.status,200);
  assert.equal((await wrongAttempt.json()).cancelled,false);
  // A late cancellation carrying attempt A must not cancel a newer attempt B.
  const secondSelect=await fetch(base+"/v1/browser/select",{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify({pageId:browserRuntime.pageId,roomId})});
  const secondSelection=await secondSelect.json();
  assert.notEqual(secondSelection.selectionAttemptId,selection.selectionAttemptId);
  const lateCancel=await fetch(base+"/v1/browser/select/cancel",{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify({pageId:browserRuntime.pageId,roomId,attemptId:selection.selectionAttemptId})});
  assert.equal(lateCancel.status,200);
  assert.equal((await lateCancel.json()).cancelled,false);
  const cancelled=await fetch(base+"/v1/browser/select/cancel",{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify({pageId:browserRuntime.pageId,roomId,attemptId:secondSelection.selectionAttemptId})});
  assert.equal(cancelled.status,200);
  assert.equal((await cancelled.json()).cancelled,true);
  const stale=await fetch(base+"/v1/browser/targets",{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify({pageId:browserRuntime.pageId,roomId})});
  assert.equal(stale.status,400);
  const invalid=await fetch(base+"/v1/browser/select/cancel",{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify({pageId:browserRuntime.pageId,roomId:"bad",attemptId:selection.selectionAttemptId})});
  assert.equal(invalid.status,400);
 },{browserRuntime});
});

test("browser target registration rejects missing or malformed group IDs", async () => {
 const browserRuntime=fakeBrowserRuntime();
 await withHost(async({base,origin})=>{
  const credentials=await (await pair(base,origin)).json();
  const auth={Origin:origin,Authorization:"Bearer "+credentials.sessionToken};
  await fetch(base+"/v1/browser/start",{method:"POST",headers:auth});
  for(const roomId of [undefined,"not-a-room"]) {
   const body={pageId:browserRuntime.pageId};if(roomId!==undefined)body.roomId=roomId;
   const response=await fetch(base+"/v1/browser/targets",{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify(body)});
   assert.equal(response.status,400);
  }
 },{browserRuntime});
});

test("server without a platform runtime advertises no capabilities and fails closed", async () => {
 await withHost(async({base,origin})=>{
  const credentials=await (await pair(base,origin)).json();
  const auth={Origin:origin,Authorization:"Bearer "+credentials.sessionToken};
  const status=await (await fetch(base+"/v1/host",{headers:auth})).json();
  assert.equal(status.executionReady,false);
  assert.equal(Object.values(status.capabilities).some(Boolean),false);
  const start=await fetch(base+"/v1/browser/start",{method:"POST",headers:auth});
  assert.equal(start.status,503);
 });
});

test("host rejects malformed and oversized JSON bodies without passing them to browser controls", async () => {
 const browserRuntime=fakeBrowserRuntime();
 await withHost(async({base,origin})=>{
  const credentials=await (await pair(base,origin)).json();
  const auth={Origin:origin,Authorization:"Bearer "+credentials.sessionToken};
  await fetch(base+"/v1/browser/start",{method:"POST",headers:auth});
  const malformed=await fetch(base+"/v1/browser/open",{
   method:"POST",headers:{...auth,"Content-Type":"application/json"},body:"{not-json"
  });
  assert.equal(malformed.status,400);
  assert.equal((await malformed.json()).error,"invalid_json");
  const array=await fetch(base+"/v1/browser/open",{
   method:"POST",headers:{...auth,"Content-Type":"application/json"},body:"[]"
  });
  assert.equal(array.status,400);
  const oversized=await fetch(base+"/v1/browser/open",{
   method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify({url:"https://chatgpt.com/",padding:"x".repeat(17*1024)})
  });
  assert.equal(oversized.status,413);
  assert.equal((await oversized.json()).error,"request_too_large");
 },{browserRuntime});
});

test("browser open route accepts standard JSON content types and rejects non-JSON", async () => {
 const browserRuntime=fakeBrowserRuntime();
 await withHost(async({base,origin})=>{
  const credentials=await (await pair(base,origin)).json();
  const auth={Origin:origin,Authorization:"Bearer "+credentials.sessionToken};
  await fetch(base+"/v1/browser/start",{method:"POST",headers:auth});
  const nonJson=await fetch(base+"/v1/browser/open",{
   method:"POST",headers:{...auth,"Content-Type":"text/plain"},body:JSON.stringify({url:"https://chatgpt.com/"})
  });
  assert.equal(nonJson.status,415);
  const standard=await fetch(base+"/v1/browser/open",{
   method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify({url:"https://chatgpt.com/"})
  });
  assert.equal(standard.status,200);
  assert.equal((await standard.json()).site,"chatgpt.com");
  const charset=await fetch(base+"/v1/browser/open",{
   method:"POST",headers:{...auth,"Content-Type":"application/json; charset=utf-8"},body:JSON.stringify({url:"https://claude.ai/"})
  });
  assert.equal(charset.status,200);
  assert.equal((await charset.json()).site,"claude.ai");
 },{browserRuntime});
});

test("disabled browser runtime reports an actionable 503 instead of a misleading bad request", async () => {
 await withHost(async({base,origin})=>{
  const credentials=await (await pair(base,origin)).json();
  const auth={Origin:origin,Authorization:"Bearer "+credentials.sessionToken};
  const response=await fetch(base+"/v1/browser/open",{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify({url:"https://chatgpt.com/"})});
  assert.equal(response.status,503);
  assert.equal((await response.json()).error,"browser_runtime_unavailable");
 });
});

test("browser target removal is authenticated, room-scoped and idempotently denied",async()=>{
 const browserRuntime=fakeBrowserRuntime();
 await withHost(async({base,origin})=>{
  const credentials=await (await pair(base,origin)).json();
  const auth={Origin:origin,Authorization:"Bearer "+credentials.sessionToken};
  const unauthorized=await fetch(base+"/v1/browser/targets/unregister",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({targetId:browserRuntime.targetId,roomId:"12345678-1234-4234-9234-123456789014"})});
  assert.equal(unauthorized.status,401);
  await fetch(base+"/v1/browser/start",{method:"POST",headers:auth});
  const selected=await fetch(base+"/v1/browser/select",{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify({pageId:browserRuntime.pageId,roomId:"12345678-1234-4234-9234-123456789014"})});
  const selectionAttemptId=(await selected.json()).selectionAttemptId;
  browserRuntime.testSetSelected();
  await fetch(base+"/v1/browser/targets",{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify({pageId:browserRuntime.pageId,roomId:"12345678-1234-4234-9234-123456789014",attemptId:selectionAttemptId})});
  const wrongRoom=await fetch(base+"/v1/browser/targets/unregister",{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify({targetId:browserRuntime.targetId,roomId:"22345678-1234-4234-9234-123456789014"})});
  assert.equal(wrongRoom.status,404);
  const removed=await fetch(base+"/v1/browser/targets/unregister",{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify({targetId:browserRuntime.targetId,roomId:"12345678-1234-4234-9234-123456789014"})});
  assert.equal(removed.status,200);
  assert.equal((await removed.json()).removed,true);
 },{browserRuntime});
});

test("emergency stop is authenticated, closes browser, revokes sessions and latches until host restart", async () => {
 const browserRuntime=fakeBrowserRuntime();
 await withHost(async({base,origin,host})=>{
  const unauthorized=await fetch(base+"/v1/host/stop",{method:"POST",headers:{Origin:origin}});
  assert.equal(unauthorized.status,401);
  assert.equal(host.killSwitchTripped,false);

  const credentials=await (await pair(base,origin)).json();
  const auth={Origin:origin,Authorization:"Bearer "+credentials.sessionToken};
  await fetch(base+"/v1/browser/start",{method:"POST",headers:auth});
  assert.equal(browserRuntime.status().running,true);

  const response=await fetch(base+"/v1/host/stop",{method:"POST",headers:auth});
  assert.equal(response.status,200);
  const result=await response.json();
  assert.equal(result.stopped,true);
  assert.equal(result.browserClosed,true);
  assert.equal(result.sessionsRevoked,true);
  assert.equal(result.restartRequired,true);
  assert.equal(browserRuntime.status().running,false);
  assert.equal(host.killSwitchTripped,true);

  const health=await fetch(base+"/health",{headers:{Origin:origin}});
  assert.equal(health.status,423);
  assert.equal((await health.json()).status,"stopped");

  const status=await fetch(base+"/v1/host",{headers:auth});
  assert.equal(status.status,423);
  const restart=await fetch(base+"/v1/browser/start",{method:"POST",headers:auth});
  assert.equal(restart.status,423);
  const rePair=await pair(base,origin);
  assert.equal(rePair.status,423);

  const repeat=await fetch(base+"/v1/host/stop",{method:"POST",headers:auth});
  assert.equal(repeat.status,423);
 },{browserRuntime});
});

test("emergency stop is authenticated, closes browser, revokes sessions and latches until host restart", async () => {
 const browserRuntime=fakeBrowserRuntime();
 await withHost(async({base,origin,host})=>{
  const unauthorized=await fetch(base+"/v1/host/stop",{method:"POST",headers:{Origin:origin}});
  assert.equal(unauthorized.status,401);
  assert.equal(host.killSwitchTripped,false);

  const credentials=await (await pair(base,origin)).json();
  const auth={Origin:origin,Authorization:"Bearer "+credentials.sessionToken};
  await fetch(base+"/v1/browser/start",{method:"POST",headers:auth});
  assert.equal(browserRuntime.status().running,true);

  const response=await fetch(base+"/v1/host/stop",{method:"POST",headers:auth});
  assert.equal(response.status,200);
  const result=await response.json();
  assert.equal(result.stopped,true);
  assert.equal(result.browserClosed,true);
  assert.equal(result.sessionsRevoked,true);
  assert.equal(result.restartRequired,true);
  assert.equal(browserRuntime.status().running,false);
  assert.equal(host.killSwitchTripped,true);

  const health=await fetch(base+"/health",{headers:{Origin:origin}});
  assert.equal(health.status,423);
  assert.equal((await health.json()).status,"stopped");

  const status=await fetch(base+"/v1/host",{headers:auth});
  assert.equal(status.status,423);
  const restart=await fetch(base+"/v1/browser/start",{method:"POST",headers:auth});
  assert.equal(restart.status,423);
  const rePair=await pair(base,origin);
  assert.equal(rePair.status,423);

  const repeat=await fetch(base+"/v1/host/stop",{method:"POST",headers:auth});
  assert.equal(repeat.status,423);
 },{browserRuntime});
});

test("wrong-origin callers cannot trigger the emergency stop", async () => {
 const browserRuntime=fakeBrowserRuntime();
 await withHost(async({base,origin})=>{
  const credentials=await (await pair(base,origin)).json();
  const hostile=await fetch(base+"/v1/host/stop",{method:"POST",headers:{
   Origin:"https://evil.test",Authorization:"Bearer "+credentials.sessionToken,
  }});
  assert.equal(hostile.status,403);
  assert.equal(browserRuntime.status().running,false);
 },{browserRuntime});
});
