import test from 'node:test';
import assert from 'node:assert/strict';
import {createMultiSurfaceExecutionService} from './multi-surface-execution.mjs';

const base={
 id:'target-1',hostId:'host-1',roomId:'group-1',
 spaceId:'space-1',sessionId:'session-1',appId:'app-1',
 identityFingerprint:'window-1',revision:1,
 locatorKind:'accessibility',locatorValue:'selected-editor'
};
function setup(surface='windows_app'){
 const target={...base,surface,...(surface==='terminal'?{
  locatorKind:'terminal_pty',locatorValue:'assistant-composer'}:{})};
 let currentText='',writes=0,permissions=0,connected=true;
 const driver={
  async inspect(){return {connected,focused:true,editable:true,surface,
   appId:target.appId,sessionId:target.sessionId,
   identityFingerprint:target.identityFingerprint,locatorValue:target.locatorValue,
   inputKind:surface==='terminal'?'assistant_composer':undefined,text:currentText};},
  async writeTextIfEmpty(x){
   writes++;
   if(surface==='terminal')assert.equal(x.submit,false);
   else assert.equal(x.submit,undefined);
   if(currentText!=='')return {state:'occupied',submitted:false};
   currentText=x.text;
   return {state:'written',submitted:false};
  }
 };
 const svc=createMultiSurfaceExecutionService({hostId:base.hostId,
  permission:async()=>{permissions++;return true},isConnected:async()=>connected});
 const cmd=(text='Draft only')=>({...target,targetId:target.id,targetRevision:target.revision,
  operation:'draft',text});
 return {svc,target,driver,cmd,
  get writes(){return writes},get permissions(){return permissions},
  occupy:value=>{currentText=value},disconnect:()=>{connected=false}};
}
for(const surface of ['desktop_app','windows_app','android_app','terminal']){
 test(surface+' only writes an approved draft to an explicitly registered matching input',async()=>{
  const v=setup(surface);
  assert.throws(()=>v.svc.register({target:v.target,driver:v.driver}),/consent/);
  const registered=v.svc.register({target:v.target,driver:v.driver,consented:true});
  assert.deepEqual(registered.operations,['draft']);
  await assert.rejects(()=>v.svc.draft({command:v.cmd(),approved:false}),/approval/);
  assert.equal(v.writes,0);
  const outcome=await v.svc.draft({command:v.cmd(),approved:true});
  assert.equal(outcome.state,'completed');
  assert.equal(outcome.submitted,false);
  assert.equal(v.writes,1);
  assert.equal(v.svc.revoke({targetId:v.target.id,roomId:'foreign'}),false);
  assert.equal(v.svc.revoke({targetId:v.target.id,roomId:v.target.roomId}),true);
  await assert.rejects(()=>v.svc.draft({command:v.cmd(),approved:true}),/Driver missing/);
 });
 test(surface+' rejects send operations and identity changes before device effect',async()=>{
  const v=setup(surface);v.svc.register({target:v.target,driver:v.driver,consented:true});
  await assert.rejects(()=>v.svc.draft({command:{...v.cmd(),operation:'wake'},approved:true}),/Draft-only/);
  await assert.rejects(()=>v.svc.draft({command:{...v.cmd(),targetRevision:2},approved:true}),/scope mismatch/);
  await assert.rejects(()=>v.svc.draft({command:{...v.cmd(),text:'Run\nnext command'},approved:true}),/single-line/);
  assert.equal(v.writes,0);
 });
}
test('browser targets are not silently routed through an OS accessibility driver',()=>{
 const v=setup('browser_tab');
 assert.throws(()=>v.svc.register({target:v.target,driver:v.driver,consented:true}),/Browser targets/);
});
test('session stopped or offline prevents further writes',async()=>{
 const v=setup();v.svc.register({target:v.target,driver:v.driver,consented:true});
 v.disconnect();
 await assert.rejects(()=>v.svc.draft({command:v.cmd(),approved:true}),/host offline/);
 assert.equal(v.writes,0);
 assert.deepEqual(v.svc.stop(),{stopped:true,remaining:0});
 await assert.rejects(()=>v.svc.draft({command:v.cmd(),approved:true}),/stopped/);
});
test('occupied native composer fails closed rather than replacing user text',async()=>{
 const v=setup();v.svc.register({target:v.target,driver:v.driver,consented:true});
 v.occupy('existing work');
 await assert.rejects(()=>v.svc.draft({command:v.cmd(),approved:true}),/identity|mismatch|preflight|occupied/i);
 assert.equal(v.writes,0);
});

test('unknown native submit attestation is not mislabeled as definitely unsent',async()=>{
 const v=setup('windows_app');
 const uncertain={
  inspect:v.driver.inspect,
  async writeTextIfEmpty(){return {state:'written',submitted:true};}
 };
 v.svc.register({target:v.target,driver:uncertain,consented:true});
 const output=await v.svc.draft({command:v.cmd(),approved:true});
 assert.equal(output.state,'needs_review');
 assert.equal(output.submitted,null);
 assert.equal(output.requiresReview,true);
});
test('same target cannot be registered twice and a different room cannot draft it',async()=>{
 const v=setup('android_app');
 v.svc.register({target:v.target,driver:v.driver,consented:true});
 assert.throws(()=>v.svc.register({target:v.target,driver:v.driver,consented:true}),/already registered/);
 await assert.rejects(()=>v.svc.draft({command:{...v.cmd(),roomId:'another-room'},approved:true}),/scope mismatch/);
 assert.equal(v.writes,0);
});

test('concurrent writes to one native target are serialized before device effect',async()=>{
 const v=setup('desktop_app');
 let completeWrite;
 const barrier=new Promise(resolve=>{completeWrite=resolve});
 let entered=0;
 const driver={
  inspect:v.driver.inspect,
  async writeTextIfEmpty(request){
   entered++;
   await barrier;
   return {state:'written',submitted:false};
  }
 };
 v.svc.register({target:v.target,driver,consented:true});
 const first=v.svc.draft({command:v.cmd(),approved:true});
 // First request awaits inspect() before reaching the device write.
 await Promise.resolve();
 await Promise.resolve();
 await assert.rejects(()=>v.svc.draft({command:v.cmd(),approved:true}),/already in progress/);
 completeWrite();
 const result=await first;
 assert.equal(result.state,'needs_review');
 assert.equal(entered,1);
});
