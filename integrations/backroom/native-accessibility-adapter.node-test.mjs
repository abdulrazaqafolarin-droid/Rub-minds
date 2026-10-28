import test from "node:test";
import assert from "node:assert/strict";
import {NativeAccessibilityDraftAdapter} from "./native-accessibility-adapter.mjs";
function fixture(surface="android_app",opts={}) {
 let content=opts.initial||"",writes=0;
 const bound={surface,appId:"com.example.ai",sessionId:"thread-7",
   identityFingerprint:"window-7",locatorValue:"compose",connected:true,focused:true,editable:true};
 const driver={inspect:async()=>({...bound,text:content,...opts.state}),
   writeText:async({text})=>{writes++;content=opts.corrupt?"unexpected":text}};
 const adapter=new NativeAccessibilityDraftAdapter({driver,surface,...bound});
 const target={...bound,locatorKind:"accessibility"};
 return {adapter,target,writes:()=>writes,value:()=>content};
}
test("native Android, Windows and desktop accessibility drafting",async()=>{
 for(const surface of ["android_app","windows_app","desktop_app"]){
  const f=fixture(surface);
  assert.equal((await f.adapter.probe({target:f.target,operation:"draft"})).connected,true);
  assert.deepEqual((await f.adapter.execute({command:{operation:"draft",text:"Draft"},target:f.target})).result,{drafted:true,submitted:false});
  assert.equal(f.writes(),1);
 }
});
test("incorrect native app, lost focus or inaccessible node blocks input",async()=>{
 for(const state of [{focused:false},{connected:false},{appId:"different"},{sessionId:"changed"},{editable:false},{locatorValue:"wrong"}]) {
  const f=fixture("android_app",{state});
  assert.equal((await f.adapter.probe({target:f.target,operation:"draft"})).connected,false);
  await assert.rejects(()=>f.adapter.execute({command:{operation:"draft",text:"X"},target:f.target}));
  assert.equal(f.writes(),0);
 }
});
test("occupied native field remains unchanged",async()=>{
 const f=fixture("desktop_app",{initial:"A human is typing"});
 await assert.rejects(()=>f.adapter.execute({command:{operation:"draft",text:"Overwrite"},target:f.target}),/occupied/);
 assert.equal(f.value(),"A human is typing");assert.equal(f.writes(),0);
});
test("unverified accessibility write requests review",async()=>{
 const f=fixture("windows_app",{corrupt:true});
 assert.equal((await f.adapter.execute({command:{operation:"draft",text:"text"},target:f.target})).state,"needs_review");
});
test("native adapter rejects automatic submit",async()=>{
 const f=fixture();
 await assert.rejects(()=>f.adapter.execute({command:{operation:"submit",text:"send"},target:f.target}),/binding/);
 assert.equal(f.writes(),0);
});
