import test from "node:test";
import assert from "node:assert/strict";
import {TargetRegistry} from "./target-registry.mjs";
import {BackroomDispatcher} from "./dispatcher.mjs";
import {LocalExecutionGuard} from "./host-runtime.mjs";
import {NativeAccessibilityDraftAdapter} from "./native-accessibility-adapter.mjs";

const surfaces=["android_app","desktop_app","windows_app"];
function fixture(surface,options={}) {
 const target={id:"input",roomId:"room",hostId:"host",spaceId:"space",
   sessionId:"session-1",appId:"chat-app",identityFingerprint:"focused-window",
   locatorKind:"accessibility",locatorValue:"input-node",surface,revision:1};
 let value="",writes=0;
 const driver={
  inspect:async()=>({surface,appId:options.appId||"chat-app",sessionId:"session-1",
    identityFingerprint:"focused-window",locatorValue:"input-node",
    connected:true,focused:options.focused!==false,editable:true,text:value}),
  writeText:async({text})=>{writes++;value=text},
 };
 const adapter=new NativeAccessibilityDraftAdapter({driver,surface,
   appId:"chat-app",sessionId:"session-1",identityFingerprint:"focused-window",
   locatorValue:"input-node"});
 const registry=new TargetRegistry();registry.register(target);
 const guard=new LocalExecutionGuard({
   host:{hostId:"host",deviceLabel:"controlled",surfaces:[surface],operations:["draft"]},
   adapter,isConnected:async()=>true,permission:async()=>options.allowed!==false,
 });
 const dispatcher=new BackroomDispatcher({registry,adapter:guard,authorize:async()=>true});
 const command={id:"task",eventId:"event",roomId:"room",hostId:"host",
   spaceId:"space",sessionId:"session-1",identityFingerprint:"focused-window",
   targetId:"input",targetRevision:1,operation:"draft",text:"@RMConnects task"};
 return {dispatcher,command,writes:()=>writes,value:()=>value};
}
test("group message can be drafted through native host guard on all native surfaces",async()=>{
 for(const surface of surfaces) {
  const f=fixture(surface);f.dispatcher.enqueue(f.command);
  assert.equal((await f.dispatcher.step("task",{approved:true})).state,"completed");
  assert.equal(f.writes(),1);assert.equal(f.value(),"@RMConnects task");
 }
});
test("unauthorized phone, desktop or Windows field cannot be modified",async()=>{
 for(const surface of surfaces)for(const scenario of [{focused:false},{allowed:false},{appId:"other"}]) {
  const f=fixture(surface,scenario);f.dispatcher.enqueue(f.command);
  assert.equal((await f.dispatcher.step("task",{approved:true})).state,"failed");
  assert.equal(f.writes(),0);
 }
});
test("native draft must not execute until explicit coordinator approval",async()=>{
 const f=fixture("desktop_app");f.dispatcher.enqueue(f.command);
 assert.equal((await f.dispatcher.step("task")).state,"awaiting_approval");
 assert.equal(f.writes(),0);
});
