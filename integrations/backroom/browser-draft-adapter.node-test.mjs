import test from "node:test";
import assert from "node:assert/strict";
import { BrowserDraftAdapter } from "./browser-draft-adapter.mjs";
function fixture(options={}) {
 let value=options.initial||"", fills=0;
 const field={
  count:async()=>options.count??1,isVisible:async()=>options.visible??true,isEnabled:async()=>true,
  inputValue:async()=>value,
  evaluate:async(_fn,text)=>{
   if(options.raceValue)value=options.raceValue;
   if(value!=="")return {state:"occupied"};
   fills++;value=options.corrupt?"bad":text;
   return {state:options.corrupt?"unverified":"inserted"};
  }
 };
 const page={isClosed:()=>options.closed||false,url:()=>options.url||"https://example.test/conversation/123",locator:()=>field};
 const adapter=new BrowserDraftAdapter({page,origin:"https://example.test",path:"/conversation/123",selector:"[role=textbox]",appId:"ai",sessionId:"123",identityFingerprint:"app:123"});
 const target={surface:"browser_tab",locatorKind:"dom",locatorValue:"[role=textbox]",appId:"ai",sessionId:"123",identityFingerprint:"app:123"};
 return {adapter,target,filled:()=>fills,value:()=>value};
}
test("authorized draft is verified and not submitted",async()=>{
 const f=fixture(); assert.equal((await f.adapter.probe({target:f.target,operation:"draft"})).focused,true);
 assert.deepEqual((await f.adapter.execute({command:{operation:"draft",text:"hello"},target:f.target})).result,{drafted:true,submitted:false});
 assert.equal(f.value(),"hello");assert.equal(f.filled(),1);
});
test("changed app URL, duplicate or hidden composer fails before write",async()=>{
 for(const options of [{url:"https://evil.test/conversation/123"},{url:"https://example.test/conversation/99"},{visible:false},{count:2},{closed:true}]){
  const f=fixture(options);
  assert.equal((await f.adapter.probe({target:f.target,operation:"draft"})).connected,false);
  await assert.rejects(()=>f.adapter.execute({command:{operation:"draft",text:"hi"},target:f.target}));
  assert.equal(f.filled(),0);
 }
});
test("existing draft remains unchanged",async()=>{
 const f=fixture({initial:"Human draft"});
 await assert.rejects(()=>f.adapter.execute({command:{operation:"draft",text:"AI draft"},target:f.target}),/overwritten/);
 assert.equal(f.value(),"Human draft");assert.equal(f.filled(),0);
});
test("a human draft appearing during preflight is never overwritten",async()=>{
 const f=fixture({raceValue:"Human typed while task was preparing"});
 await assert.rejects(()=>f.adapter.execute({command:{operation:"draft",text:"AI text"},target:f.target}),/overwritten/);
 assert.equal(f.value(),"Human typed while task was preparing");
 assert.equal(f.filled(),0);
});
test("unverified write does not count as success",async()=>{
 const f=fixture({corrupt:true});
 assert.equal((await f.adapter.execute({command:{operation:"draft",text:"hello"},target:f.target})).state,"needs_review");
});
test("submitting or using another conversation is prohibited",async()=>{
 const f=fixture();
 await assert.rejects(()=>f.adapter.execute({command:{operation:"submit",text:"hello"},target:f.target}),/changed/);
 await assert.rejects(()=>f.adapter.execute({command:{operation:"draft",text:"hello"},target:{...f.target,sessionId:"other"}}),/changed/);
});

test("a query or fragment change invalidates the bound conversation",async()=>{
 for(const options of [
  {url:"https://example.test/conversation/123?thread=two"},
  {url:"https://example.test/conversation/123#another"},
 ]) {
  const f=fixture(options);
  await assert.rejects(()=>f.adapter.execute({command:{operation:"draft",text:"hello"},target:f.target}),/conversation changed/);
  assert.equal(f.filled(),0);
 }
});
