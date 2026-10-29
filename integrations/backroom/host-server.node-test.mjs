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
  enableContinuousWake:async input=>{if(input.confirmed!==true)throw Object.assign(Error("confirmation required"),{status:403});if(!targets.some(t=>t.id===input.targetId&&t.roomId===input.roomId))throw Object.assign(Error("target scope mismatch"),{status:409});return {grantId:"42345678-1234-4234-9234-123456789099",createdAt:1,expiresAt:900001,maxPerMinute:6,scope:{hostId:"host-test",groupId:input.roomId,participantId:input.participantId,sessionId:input.sessionId,bindingId:input.bindingId,targetId:input.targetId,identityFingerprint:"fake-window",targetRevision:1},mode:"canonical-trigger-only"}},
  revokeContinuousWake:async input=>input.grantId==="42345678-1234-4234-9234-123456789099"&&input.targetId===targetId&&targets.some(t=>t.id===input.targetId&&t.roomId===input.roomId),
  wake:async (targetId,eventId,grantId,{roomId}={})=>{if(grantId!=="42345678-1234-4234-9234-123456789099")throw Object.assign(Error("grant invalid"),{status:403});if(!targets.some(t=>t.id===targetId&&t.roomId===roomId))throw Object.assign(Error("target scope mismatch"),{status:409});return {state:"completed",reason:null,result:{triggerSubmitted:true,confirmation:"composer-cleared"},submitted:true,triggerOnly:true}},
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



test("failed browser closure still latches stop and revokes sessions", async () => {
 const browserRuntime=fakeBrowserRuntime();
 const normalStop=browserRuntime.stop.bind(browserRuntime);
 let stopCalls=0;
 browserRuntime.stop=async()=>{
  stopCalls++;
  if(stopCalls===1)throw new Error("simulated close failure");
  return normalStop();
 };
 await withHost(async({base,origin,host})=>{
  const credentials=await (await pair(base,origin)).json();
  const auth={Origin:origin,Authorization:"Bearer "+credentials.sessionToken};
  await fetch(base+"/v1/browser/start",{method:"POST",headers:auth});

  const response=await fetch(base+"/v1/host/stop",{method:"POST",headers:auth});
  assert.equal(response.status,503);
  const result=await response.json();
  assert.equal(result.stopped,true);
  assert.equal(result.browserClosed,false);
  assert.equal(result.sessionsRevoked,true);
  assert.equal(result.restartRequired,true);
  assert.equal(result.error,"emergency_stop_incomplete");
  assert.equal(host.killSwitchTripped,true);
  assert.equal(browserRuntime.status().running,true,"a failed close must not be misreported as successful");
  assert.equal((await fetch(base+"/v1/browser/start",{method:"POST",headers:auth})).status,423);
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


test("canonical wake HTTP routes require pairing, explicit opt-in, exact scope and grant",async()=>{
 const browserRuntime=fakeBrowserRuntime();
 await withHost(async({base,origin})=>{
  const targetId=browserRuntime.targetId,roomId="12345678-1234-4234-9234-123456789014";
  assert.equal((await fetch(base+"/v1/browser/wake/grants",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({confirmed:true})})).status,401);
  const credentials=await (await pair(base,origin)).json();
  const auth={Origin:origin,Authorization:"Bearer "+credentials.sessionToken,"Content-Type":"application/json"};
  assert.equal((await fetch(base+"/v1/browser/wake/grants",{method:"POST",headers:auth,body:JSON.stringify({confirmed:false})})).status,403);
  const missing=await fetch(base+"/v1/browser/wake/grants",{method:"POST",headers:auth,body:JSON.stringify({confirmed:true,targetId,roomId})});
  assert.equal(missing.status,400);
  await fetch(base+"/v1/browser/start",{method:"POST",headers:auth});
  const selection=await (await fetch(base+"/v1/browser/select",{method:"POST",headers:auth,body:JSON.stringify({pageId:browserRuntime.pageId,roomId})})).json();
  browserRuntime.testSetSelected();
  assert.equal((await fetch(base+"/v1/browser/targets",{method:"POST",headers:auth,body:JSON.stringify({pageId:browserRuntime.pageId,roomId,attemptId:selection.selectionAttemptId})})).status,201);
  const request={confirmed:true,targetId,roomId,participantId:"32345678-1234-4234-9234-123456789011",sessionId:browserRuntime.pageId,bindingId:"32345678-1234-4234-9234-123456789012"};
  const grantResponse=await fetch(base+"/v1/browser/wake/grants",{method:"POST",headers:auth,body:JSON.stringify(request)});
  assert.equal(grantResponse.status,201);
  const grant=await grantResponse.json();assert.equal(grant.mode,"canonical-trigger-only");assert.equal(grant.scope.targetId,targetId);
  const revokeWrong=await fetch(base+"/v1/browser/wake/grants/revoke",{method:"POST",headers:auth,body:JSON.stringify({grantId:grant.grantId,targetId,roomId:"22345678-1234-4234-9234-123456789014",bindingId:request.bindingId})});
  assert.equal(revokeWrong.status,404);
  const wake=await fetch(base+"/v1/browser/wake",{method:"POST",headers:auth,body:JSON.stringify({grantId:grant.grantId,targetId,roomId,eventId:"42345678-1234-4234-9234-123456789010"})});
  assert.equal(wake.status,200);assert.equal((await wake.json()).triggerOnly,true);
  const revoke=await fetch(base+"/v1/browser/wake/grants/revoke",{method:"POST",headers:auth,body:JSON.stringify({grantId:grant.grantId,targetId,roomId,bindingId:request.bindingId})});
  assert.equal(revoke.status,200);assert.equal((await revoke.json()).revoked,true);
 },{browserRuntime});
});

test("enrollment only exposes a digest to the locally paired owner browser",async()=>{
 const digest="d".repeat(64);
 assert.throws(()=>createBackroomHostServer({allowedOrigins:["https://rub-minds.vercel.app"],enrollmentDigest:"invalid"}),/enrollment digest/);
 await withHost(async({base,origin})=>{
  const unauthorized=await fetch(base+"/v1/host",{headers:{Origin:origin}});
  assert.equal(unauthorized.status,401);
  const credentials=await (await pair(base,origin)).json();
  const authorized=await fetch(base+"/v1/host",{headers:{Origin:origin,Authorization:"Bearer "+credentials.sessionToken}});
  assert.equal(authorized.status,200);
  const status=await authorized.json();
  assert.equal(status.enrollmentDigest,digest);
  assert.equal(Object.hasOwn(status,"hostToken"),false);
 },{enrollmentDigest:digest});
});


test("local approval activates hosted wake, and unpair/revoke stop remote worker",async()=>{
 const roomId="12345678-1234-4234-9234-123456789014";
 const participantId="12345678-1234-4234-9234-123456789015";
 const bindingId="12345678-1234-4234-9234-123456789016";
 const sessionId="12345678-1234-4234-9234-123456789017";
 const targetId="12345678-1234-4234-9234-123456789018";
 const grantId="12345678-1234-4234-9234-123456789019";
 const calls=[];
 const browserRuntime={
  status:()=>({running:true,pages:1,capabilities:{browserDraft:true,browserCanonicalWake:true}}),
  stop:async()=>{calls.push("browser-stop");},
  enableContinuousWake:async input=>{
   assert.equal(input.confirmed,true);
   calls.push("local-grant");
   return {grantId,scope:{hostId:"host-test",bindingId,groupId:roomId,participantId,sessionId,targetId}};
  },
  revokeContinuousWake:()=>{calls.push("revoke");return true;}
 };
 const wakeService={
  activateAndStart:async()=>{calls.push("remote-activate");},
  stop:async binding=>{calls.push("poller-stop:"+String(binding??"all"));}
 };
 await withHost(async({base,origin})=>{
  const pairResponse=await pair(base,origin);
  const token=(await pairResponse.json()).sessionToken;
  const auth={Origin:origin,Authorization:"Bearer "+token,"Content-Type":"application/json"};
  const body={targetId,roomId,participantId,sessionId,bindingId,confirmed:true};
  const response=await fetch(base+"/v1/browser/wake/grants",{method:"POST",headers:auth,body:JSON.stringify(body)});
  assert.equal(response.status,201);
  assert.deepEqual(calls.slice(0,2),["local-grant","remote-activate"]);
  const revoke=await fetch(base+"/v1/browser/wake/grants/revoke",{method:"POST",headers:auth,
   body:JSON.stringify({grantId,targetId,roomId,bindingId})});
  assert.equal(revoke.status,200);
  assert.ok(calls.includes("poller-stop:"+bindingId));
  const unpair=await fetch(base+"/v1/unpair",{method:"POST",headers:auth});
  assert.equal(unpair.status,200);
  assert.ok(calls.filter(x=>x==="poller-stop").length>=2);
 },{browserRuntime,wakeService});
});
test("remote activation failure revokes local grant and never reports success",async()=>{
 const roomId="12345678-1234-4234-9234-123456789014";
 const targetId="12345678-1234-4234-9234-123456789018";
 const grantId="12345678-1234-4234-9234-123456789019";
 let revoked=0;
 const browserRuntime={
  status:()=>({running:true,pages:1,capabilities:{browserCanonicalWake:true}}),
  stop:async()=>{},
  enableContinuousWake:async()=>({grantId}),
  revokeContinuousWake:()=>{revoked++;return true;}
 };
 const wakeService={
  activateAndStart:async()=>{throw new Error("secret network failure");},
  stop:async()=>{}
 };
 await withHost(async({base,origin})=>{
  const token=(await (await pair(base,origin)).json()).sessionToken;
  const response=await fetch(base+"/v1/browser/wake/grants",{method:"POST",
   headers:{Origin:origin,Authorization:"Bearer "+token,"Content-Type":"application/json"},
   body:JSON.stringify({targetId,roomId,participantId:"12345678-1234-4234-9234-123456789015",
    sessionId:"12345678-1234-4234-9234-123456789017",
    bindingId:"12345678-1234-4234-9234-123456789016",confirmed:true})});
  assert.equal(response.status,503);
  assert.equal(revoked,1);
  assert.doesNotMatch(await response.text(),/secret network/);
 },{browserRuntime,wakeService});
});


test("multi-surface routes require pairing and never expose native registration",async()=>{
 const calls=[];
 const multiSurfaceRuntime={
  list:()=>[{id:"selected-native",surface:"windows_app",roomId:"group-1",operations:["draft"]}],
  draft:async input=>{calls.push(input);return {state:"completed",submitted:false,result:{drafted:true}}},
  stop:()=>{calls.push("stopped")}
 };
 await withHost(async({base,origin})=>{
  const unauth=await fetch(base+"/v1/surfaces/targets",{headers:{Origin:origin}});
  assert.equal(unauth.status,401);
  const session=(await (await pair(base,origin)).json()).sessionToken;
  const headers={Origin:origin,Authorization:"Bearer "+session};
  const list=await fetch(base+"/v1/surfaces/targets",{headers});
  assert.equal(list.status,200);
  assert.equal((await list.json()).targets[0].operations[0],"draft");
  const unapproved=await fetch(base+"/v1/surfaces/draft",{
   method:"POST",headers:{...headers,"Content-Type":"application/json"},
   body:JSON.stringify({approved:false,command:{operation:"draft",text:"hello"}})});
  assert.equal(unapproved.status,403);
  assert.equal(calls.length,0);
  const approved=await fetch(base+"/v1/surfaces/draft",{
   method:"POST",headers:{...headers,"Content-Type":"application/json"},
   body:JSON.stringify({approved:true,command:{operation:"draft",text:"hello"}})});
  assert.equal(approved.status,200);
  assert.equal((await approved.json()).submitted,false);
  assert.equal(calls.length,1);
  const registration=await fetch(base+"/v1/surfaces/register",{
   method:"POST",headers:{...headers,"Content-Type":"application/json"},
   body:JSON.stringify({surface:"android_app",driver:"pretend",approved:true})});
  assert.equal(registration.status,404);
  const unpair=await fetch(base+"/v1/unpair",{
   method:"POST",headers});
  assert.equal(unpair.status,200);
  assert.ok(calls.includes("stopped"));
 },{multiSurfaceRuntime});
 assert.ok(calls.includes("stopped"));
});
test("native multi-surface routes remain unavailable when no OS driver runtime is installed",async()=>{
 await withHost(async({base,origin})=>{
  const session=(await (await pair(base,origin)).json()).sessionToken;
  const status=await fetch(base+"/v1/surfaces/targets",{
   headers:{Origin:origin,Authorization:"Bearer "+session}});
  assert.equal(status.status,503);
  assert.equal((await status.json()).error,"native_runtime_unavailable");
 });
});


test("paired host configuration rejects browser-selected credential URLs and accepts only scope",async()=>{
 let received=null;
 const wakeService={configure(input){received=input;return {configured:true,bindingId:input.bindingId};},stop:async()=>{}};
 const bindingId="12345678-1234-4234-9234-123456789077";
 const sessionDigest="a".repeat(64);
 const publishableKey="sb_publishable_exampleKey0123456789abcdef";
 await withHost(async({base,origin})=>{
  const token=(await (await pair(base,origin)).json()).sessionToken;
  const headers={Origin:origin,Authorization:"Bearer "+token,"Content-Type":"application/json"};
  const exfil=await fetch(base+"/v1/backroom/configure",{method:"POST",headers,
   body:JSON.stringify({gatewayUrl:"https://attacker.example/",bindingId,sessionDigest,publishableKey})});
  assert.equal(exfil.status,400);
  assert.equal(received,null);
  const valid=await fetch(base+"/v1/backroom/configure",{method:"POST",headers,
   body:JSON.stringify({bindingId,sessionDigest,publishableKey})});
  assert.equal(valid.status,200);
  assert.deepEqual(received,{bindingId,sessionDigest,publishableKey});
 },{wakeService});
});


test("paired host stop route requires auth and calls the wake service stop hook",async()=>{
 let stopped=0;
 const wakeService={configure:()=>({configured:true}),stop:async()=>{stopped++;return {stopped:true,remotelyDeactivated:true}}};
 await withHost(async({base,origin})=>{
  const denied=await fetch(base+"/v1/backroom/stop",{method:"POST",headers:{Origin:origin}});
  assert.equal(denied.status,401);
  assert.equal(stopped,0);
  const token=(await (await pair(base,origin)).json()).sessionToken;
  const response=await fetch(base+"/v1/backroom/stop",{method:"POST",
   headers:{Origin:origin,Authorization:"Bearer "+token}});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{stopped:true,remoteDeactivationConfirmed:true});
  assert.equal(stopped,1);
 },{wakeService});
});
test("host configure route permits only scope plus public project key, never gateway override",async()=>{
 let received=null;
 const wakeService={configure(input){received=input;return {configured:true,bindingId:input.bindingId}},stop:async()=>{}};
 const bindingId="12345678-1234-4234-9234-123456789078";
 const sessionDigest="c".repeat(64);
 const publishableKey="sb_publishable_exampleKey0123456789abcdef";
 await withHost(async({base,origin})=>{
  const token=(await (await pair(base,origin)).json()).sessionToken;
  const headers={Origin:origin,Authorization:"Bearer "+token,"Content-Type":"application/json"};
  const bad=await fetch(base+"/v1/backroom/configure",{method:"POST",headers,
   body:JSON.stringify({gatewayUrl:"https://attacker.example/",bindingId,sessionDigest,publishableKey})});
  assert.equal(bad.status,400);
  assert.equal(received,null);
  const good=await fetch(base+"/v1/backroom/configure",{method:"POST",headers,
   body:JSON.stringify({bindingId,sessionDigest,publishableKey})});
  assert.equal(good.status,200);
  assert.deepEqual(received,{bindingId,sessionDigest,publishableKey});
 },{wakeService});
});
