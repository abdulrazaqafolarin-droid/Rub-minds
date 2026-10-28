import test from "node:test";
import assert from "node:assert/strict";
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
 let running=false, selected=null, selectionRoom=null, targets=[];
 const pageId="12345678-1234-4234-9234-123456789012";
 const targetId="12345678-1234-4234-9234-123456789013";
 const status=()=>({running,pages:running?1:0,capabilities:{browserDraft:running,desktopAccessibility:false,androidAccessibility:false,terminal:false}});
 return {
  status,
  start:async()=>{running=true;return status()},
  stop:async()=>{running=false;targets=[];return status()},
  listPages:async()=>running?[{pageId,title:"Test chat",site:"chatgpt.com",canSelect:true}]:[],
  startSelection:async(id,roomId)=>{if(id!==pageId)throw Error("page not found");selectionRoom=roomId;selected={state:"pending"};return selected},
  getSelection:async()=>({state:selected?.state||"unavailable"}),
  registerSelectedTarget:async(id,roomId)=>{if(id!==pageId||selected?.state!=="selected"||roomId!==selectionRoom)throw Error("selection missing or wrong room");const t={id:targetId,pageId,roomId,title:"Test chat",site:"chatgpt.com",surface:"browser_tab",operations:["draft"]};targets.push(t);return t},
  listTargets:()=>targets,
  draft:async(id,text,{approved,roomId}={})=>{if(approved!==true)throw Error("approval required");if(!targets.some(t=>t.id===id&&t.roomId===roomId))throw Error("target scope mismatch");return {state:"completed",result:{drafted:true,submitted:false},submitted:false}},
  testSetSelected:()=>{selected={state:"selected"};},
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
  const pages=await (await fetch(base+"/v1/browser/pages",{headers:auth})).json();
  assert.equal(pages.pages[0].site,"chatgpt.com");
  assert.equal((await fetch(base+"/v1/browser/select",{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify({pageId:browserRuntime.pageId,roomId:"12345678-1234-4234-9234-123456789014"})})).status,200);
  browserRuntime.testSetSelected();
  assert.equal((await fetch(base+"/v1/browser/targets",{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify({pageId:browserRuntime.pageId,roomId:"12345678-1234-4234-9234-123456789014"})})).status,201);
  const draft=await fetch(base+"/v1/browser/draft",{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify({targetId:browserRuntime.targetId,roomId:"12345678-1234-4234-9234-123456789014",text:"draft only",approved:true})});
  assert.equal(draft.status,200);assert.equal((await draft.json()).submitted,false);
  assert.equal((await fetch(base+"/v1/unpair",{method:"POST",headers:auth})).status,200);
  assert.equal((await fetch(base+"/v1/browser/pages",{headers:auth})).status,401);
 },{browserRuntime});
});
test("browser drafting endpoint requires explicit approval and JSON content type",async()=>{
 const browserRuntime=fakeBrowserRuntime();
 await withHost(async({base,origin})=>{
  const creds=await (await pair(base,origin)).json();const auth={Origin:origin,Authorization:"Bearer "+creds.sessionToken};
  await fetch(base+"/v1/browser/start",{method:"POST",headers:auth});
  await fetch(base+"/v1/browser/select",{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify({pageId:browserRuntime.pageId,roomId:"12345678-1234-4234-9234-123456789014"})});
  browserRuntime.testSetSelected();
  await fetch(base+"/v1/browser/targets",{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify({pageId:browserRuntime.pageId,roomId:"12345678-1234-4234-9234-123456789014"})});
  const noApproval=await fetch(base+"/v1/browser/draft",{method:"POST",headers:{...auth,"Content-Type":"application/json"},body:JSON.stringify({targetId:browserRuntime.targetId,roomId:"12345678-1234-4234-9234-123456789014",text:"text",approved:false})});
  assert.equal(noApproval.status,403);
  const noJson=await fetch(base+"/v1/browser/select",{method:"POST",headers:auth,body:"{}"});
  assert.equal(noJson.status,415);
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
