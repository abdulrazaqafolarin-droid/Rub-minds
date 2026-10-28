import test from "node:test";
import assert from "node:assert/strict";
import { BrowserHostRuntime } from "./browser-host-runtime.mjs";

function fakePage({url="https://chatgpt.com/c/test",title="Research thread",selection=null,closed=false}={}) {
 const handlers={}; let input="", pageUrl=url;
 return {
  handlers, isClosed:()=>closed, url:()=>pageUrl, title:async()=>title,
  on:(event,fn)=>{handlers[event]=fn},
  locator:()=>({count:async()=>1,isVisible:async()=>true,isEnabled:async()=>true,inputValue:async()=>input,fill:async text=>{input=text}}),
  evaluate:async fn=>{
   if(typeof fn==="function" && fn.name==="installSelectionOverlay")return {state:"pending"};
   if(selection && fn.toString().includes("RM_BACKROOM_SELECTION_V1"))return selection;
   if(fn.toString().includes("RM_BACKROOM_SELECTION_V1"))return null;
   return null;
  },
  setSelection:v=>selection=v, value:()=>input, setUrl:v=>pageUrl=v, close:()=>{closed=true;handlers.close?.()},
 };
}
function fakeContext(pages=[]) {
 const handlers={};
 return {handlers,pages:()=>pages, on:(event,fn)=>{handlers[event]=fn}, close:async()=>{handlers.close?.();}};
}
function factory(context) {
 return new BrowserHostRuntime({hostId:"host",profileDir:"/tmp/profile-test",chromiumProvider:async()=>({launchPersistentContext:async()=>context})});
}
test("host starts a visible managed context and only advertises browser capability while running",async()=>{
 const p=fakePage({url:"https://claude.ai/chat/123"}),context=fakeContext([p]),runtime=factory(context);
 assert.equal(runtime.status().running,false);
 const status=await runtime.start();assert.equal(status.running,true);assert.equal(status.capabilities.browserDraft,true);
 assert.deepEqual((await runtime.listPages()).map(x=>x.site),["claude.ai"]);
 await runtime.stop();assert.equal(runtime.status().running,false);
});
test("only web pages are listed and page output hides conversation paths",async()=>{
 const pages=[fakePage({url:"https://chatgpt.com/c/private-thread"}),fakePage({url:"file:///private.txt"}),fakePage({url:"about:blank"})];
 const runtime=factory(fakeContext(pages));await runtime.start();
 const result=await runtime.listPages();assert.equal(result.length,1);assert.equal(result[0].site,"chatgpt.com");assert.equal(result[0].title,"Research thread");
 await runtime.stop();
});
test("selection registration requires one selected target and an empty composer",async()=>{
 const p=fakePage(),runtime=factory(fakeContext([p]));await runtime.start();
 const [page]=await runtime.listPages();
 await assert.rejects(()=>runtime.registerSelectedTarget(page.pageId),/Select one input/);
 p.setSelection({state:"selected",selector:"[role=textbox]",tagName:"textarea"});
 const target=await runtime.registerSelectedTarget(page.pageId);assert.equal(target.operations[0],"draft");
 assert.equal(runtime.listTargets().length,1);await runtime.stop();
});
test("draft requires explicit approval and never reports submitted",async()=>{
 const p=fakePage(),runtime=factory(fakeContext([p]));await runtime.start();
 const [page]=await runtime.listPages();p.setSelection({state:"selected",selector:"[role=textbox]",tagName:"textarea"});
 const target=await runtime.registerSelectedTarget(page.pageId);
 await assert.rejects(()=>runtime.draft(target.id,"hello"),/approval/);
 const result=await runtime.draft(target.id,"hello",{approved:true});
 assert.equal(result.state,"completed");assert.equal(result.submitted,false);assert.equal(p.value(),"hello");
 await runtime.stop();
});
test("closed pages and unsupported protocols are rejected",async()=>{
 const p=fakePage({url:"file:///private.txt"}),runtime=factory(fakeContext([p]));await runtime.start();
 assert.equal((await runtime.listPages()).length,0);
 await assert.rejects(()=>runtime.startSelection("unknown"),/unavailable/);
 await runtime.stop();
});
