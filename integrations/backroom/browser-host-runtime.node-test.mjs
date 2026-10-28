import test from "node:test";
import assert from "node:assert/strict";
import { BrowserHostRuntime } from "./browser-host-runtime.mjs";

function fakePage({url="https://chatgpt.com/c/test",title="Research thread",selection=null,closed=false}={}) {
 const handlers={}; let input="", pageUrl=url, bindingMarker=null;
 const locator = (selector="") => {
  const markerMatch=/\[data-rm-backroom-binding="([^"]+)"\]$/.exec(selector);
  const expectedMarker=markerMatch?.[1];
  const isBound=Boolean(expectedMarker);
  return {
   count:async()=>isBound?(bindingMarker===expectedMarker?1:0):1,
   isVisible:async()=>true,isEnabled:async()=>true,
   inputValue:async()=>input,
   getAttribute:async name=>name==="data-rm-backroom-binding"?bindingMarker:null,
   evaluate:async(fn,arg)=>{
    const code=String(fn);
    if(code.includes("setAttribute")&&code.includes("data-rm-backroom-binding")){
      if(bindingMarker)return {state:"existing",marker:bindingMarker};
      bindingMarker=arg;return {state:"bound",marker:bindingMarker};
    }
    if(code.includes("removeAttribute")&&code.includes("data-rm-backroom-binding")){
      if(!isBound||bindingMarker===expectedMarker)bindingMarker=null;
      return true;
    }
    if(isBound&&bindingMarker!==expectedMarker)throw Error("stale target element");
    if(input!=="")return {state:"occupied"};
    input=arg;return {state:"inserted"};
   }
  };
 };
 return {
  handlers,isClosed:()=>closed,url:()=>pageUrl,title:async()=>title,on:(event,fn)=>{handlers[event]=fn},
  goto:async value=>{pageUrl=value},locator,
  evaluate:async fn=>{
   if(typeof fn==="function" && fn.name==="installSelectionOverlay")return {state:"pending"};
   if(selection && fn.toString().includes("RM_BACKROOM_SELECTION_V1"))return selection;
   if(fn.toString().includes("RM_BACKROOM_SELECTION_V1"))return null;
   return null;
  },
  setSelection:v=>selection=v,value:()=>input,setUrl:v=>pageUrl=v,replaceNode:()=>{bindingMarker=null},
  setBindingMarker:v=>{bindingMarker=v},bindingMarker:()=>bindingMarker,
  close:()=>{closed=true;handlers.close?.()},
 };
}
function fakeContext(pages=[]) {
 const handlers={};
 return {handlers,pages:()=>pages, newPage:async()=>{const p=fakePage({url:"about:blank"});pages.push(p);return p;}, on:(event,fn)=>{handlers[event]=fn}, close:async()=>{handlers.close?.();}};
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
 await runtime.startSelection(page.pageId, "room-1");
 await assert.rejects(()=>runtime.registerSelectedTarget(page.pageId, "room-1"),/Select one input/);
 p.setSelection({state:"selected",selector:"[role=textbox]",tagName:"textarea"});
 const target=await runtime.registerSelectedTarget(page.pageId, "room-1");assert.equal(target.operations[0],"draft");
 assert.equal((await runtime.listTargets()).length,1);await runtime.stop();
});
test("draft requires explicit approval and never reports submitted",async()=>{
 const p=fakePage(),runtime=factory(fakeContext([p]));await runtime.start();
 const [page]=await runtime.listPages();await runtime.startSelection(page.pageId, "room-1");p.setSelection({state:"selected",selector:"[role=textbox]",tagName:"textarea"});
 const target=await runtime.registerSelectedTarget(page.pageId, "room-1");
 await assert.rejects(()=>runtime.draft(target.id,"hello",{roomId:"room-1"}),/approval/);
 const result=await runtime.draft(target.id,"hello",{approved:true,roomId:"room-1"});
 assert.equal(result.state,"completed");assert.equal(result.submitted,false);assert.equal(p.value(),"hello");
 await runtime.stop();
});
test("closed pages and unsupported protocols are rejected",async()=>{
 const p=fakePage({url:"file:///private.txt"}),runtime=factory(fakeContext([p]));await runtime.start();
 assert.equal((await runtime.listPages()).length,0);
 await assert.rejects(()=>runtime.startSelection("unknown"),/unavailable/);
 await runtime.stop();
});

test("managed browser opens safe URLs and reuses only a blank tab",async()=>{
 const blank=fakePage({url:"about:blank"});
 const context=fakeContext([blank]);
 const runtime=factory(context);await runtime.start();
 const page=await runtime.openUrl("https://chatgpt.com/");
 assert.equal(page.site,"chatgpt.com");
 assert.equal((await runtime.listPages()).length,1);
 await assert.rejects(()=>runtime.openUrl("javascript:alert(1)"),/Only HTTPS/);
 await assert.rejects(()=>runtime.openUrl("http://example.com"),/Only HTTPS/);
 await assert.rejects(()=>runtime.openUrl("https://user:password@example.com"),/Only HTTPS/);
 await runtime.stop();
});
test("managed browser opens a second tab instead of replacing existing work",async()=>{
 const existing=fakePage({url:"https://claude.ai/chat/active"});
 const context=fakeContext([existing]);
 const runtime=factory(context);await runtime.start();
 const opened=await runtime.openUrl("https://chatgpt.com/");
 assert.equal(existing.url(),"https://claude.ai/chat/active");
 assert.equal(opened.site,"chatgpt.com");
 assert.equal((await runtime.listPages()).length,2);
 await runtime.stop();
});

test("target is invalidated when the SPA changes its query or hash conversation identity",async()=>{
 const p=fakePage({url:"https://chatgpt.com/c/one?thread=one"}),runtime=factory(fakeContext([p]));await runtime.start();
 const [page]=await runtime.listPages();
 await runtime.startSelection(page.pageId,"room-1");
 p.setSelection({state:"selected",selector:"[role=textbox]",tagName:"textarea"});
 const target=await runtime.registerSelectedTarget(page.pageId,"room-1");
 assert.equal((await runtime.listTargets()).length,1);
 p.setUrl("https://chatgpt.com/c/one?thread=two");
 assert.equal((await runtime.listTargets()).length,0);
 await assert.rejects(()=>runtime.draft(target.id,"stale",{approved:true,roomId:"room-1"}),/target unavailable/i);
 await runtime.stop();
});

test("a drag selection is cancelled when the active conversation route changes",async()=>{
 const p=fakePage({url:"https://chatgpt.com/c/one?thread=one"}),runtime=factory(fakeContext([p]));await runtime.start();
 const [page]=await runtime.listPages();
 await runtime.startSelection(page.pageId,"room-1");
 p.setUrl("https://chatgpt.com/c/one?thread=two");
 const result=await runtime.getSelection(page.pageId);
 assert.equal(result.state,"cancelled");
 assert.match(result.message,/conversation changed/);
 p.setSelection({state:"selected",selector:"[role=textbox]"});
 await assert.rejects(()=>runtime.registerSelectedTarget(page.pageId,"room-1"),/conversation/);
 await runtime.stop();
});

test("in-place composer replacement invalidates the target instead of rebinding it",async()=>{
 const p=fakePage(),runtime=factory(fakeContext([p]));await runtime.start();
 const [page]=await runtime.listPages();
 await runtime.startSelection(page.pageId,"room-1");
 p.setSelection({state:"selected",selector:'textarea[aria-label="Prompt"]',tagName:"textarea"});
 const target=await runtime.registerSelectedTarget(page.pageId,"room-1");
 assert.equal((await runtime.listTargets()).length,1);
 p.replaceNode();
 assert.equal((await runtime.listTargets()).length,0);
 await assert.rejects(()=>runtime.draft(target.id,"stale",{approved:true,roomId:"room-1"}),/target unavailable/i);
 await runtime.stop();
});
test("the same selected node reuses its group target instead of making duplicates",async()=>{
 const p=fakePage(),runtime=factory(fakeContext([p]));await runtime.start();
 const [page]=await runtime.listPages();
 await runtime.startSelection(page.pageId,"room-1");p.setSelection({state:"selected",selector:'textarea[aria-label="Prompt"]'});
 const first=await runtime.registerSelectedTarget(page.pageId,"room-1");
 await runtime.startSelection(page.pageId,"room-1");p.setSelection({state:"selected",selector:'textarea[aria-label="Prompt"]'});
 const second=await runtime.registerSelectedTarget(page.pageId,"room-1");
 assert.equal(second.id,first.id);
 assert.equal((await runtime.listTargets()).length,1);
 await runtime.stop();
});
test("unregister removes its DOM marker only after the last room binding is removed",async()=>{
 const p=fakePage(),runtime=factory(fakeContext([p]));await runtime.start();
 const [page]=await runtime.listPages();
 await runtime.startSelection(page.pageId,"room-1");p.setSelection({state:"selected",selector:'textarea[aria-label="Prompt"]'});
 const first=await runtime.registerSelectedTarget(page.pageId,"room-1");
 await runtime.startSelection(page.pageId,"room-2");p.setSelection({state:"selected",selector:'textarea[aria-label="Prompt"]'});
 const second=await runtime.registerSelectedTarget(page.pageId,"room-2");
 assert.equal(await runtime.unregisterTarget(first.id,"room-1"),true);
 assert.equal((await runtime.listTargets()).length,1);
 assert.equal(await runtime.unregisterTarget(second.id,"room-2"),true);
 assert.equal((await runtime.listTargets()).length,0);
 await runtime.stop();
});

test("site-owned marker attributes are cleared before host binding",async()=>{
 const p=fakePage(),runtime=factory(fakeContext([p]));await runtime.start();
 const foreign="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
 p.setBindingMarker(foreign);
 const [page]=await runtime.listPages();
 await runtime.startSelection(page.pageId,"room-1");
 p.setSelection({state:"selected",selector:'textarea[aria-label="Prompt"]'});
 const target=await runtime.registerSelectedTarget(page.pageId,"room-1");
 assert.notEqual(p.bindingMarker(),foreign);
 assert.equal((await runtime.listTargets()).length,1);
 await runtime.stop();
});

test("repeated browser drafts do not exhaust the bounded dispatcher queue",async()=>{
 const p=fakePage(),runtime=factory(fakeContext([p]));await runtime.start();
 const [page]=await runtime.listPages();
 await runtime.startSelection(page.pageId,"room-1");
 p.setSelection({state:"selected",selector:'textarea[aria-label="Prompt"]'});
 const target=await runtime.registerSelectedTarget(page.pageId,"room-1");
 for(let i=0;i<220;i++){
  const result=await runtime.draft(target.id,"draft "+i,{approved:true,roomId:"room-1"});
  assert.equal(result.state,"completed");
 }
 await runtime.stop();
});
