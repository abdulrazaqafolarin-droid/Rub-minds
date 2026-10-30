import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompanionSession} from './companion-session.mjs';
import {createNativeCompanionKernel} from './native-companion-kernel.mjs';
const scope={roomId:'room-1',spaceId:'space-1',appId:'shell-1',surface:'terminal',identityFingerprint:'fp-1'};
const cmd=(action,id)=>({commandId:id,deviceId:'device-1',userId:'owner-1',sentAt:1000,action,scope,
  approved:true,trustedLocalDecision:true,grantId:'remote-fake'});
function fixture(displayApproval){
 const commands=[];
 let killed=0;
 const kernel=createNativeCompanionKernel({inventory:async()=>[
    {id:'shell-1',fingerprint:'fp-1',terminal:true,shell:'/bin/sh',args:[]}],
   isDeviceConnected:()=>true,createPty:async()=>({kill(){killed++},write(){},resize(){}})});
 const session=createCompanionSession({deviceId:'device-1',userId:'owner-1',kernel,now:()=>1000,
  isAuthenticated:async()=>true,authorizeRoom:async()=>true,
  displayApproval:async request=>{commands.push(request);return displayApproval(request)}});
 return {session,kernel,commands,get killed(){return killed}};
}
test('native approval launches real PTY and no secret grant is returned',async()=>{
 const f=fixture(()=>true);
 const response=await f.session.request(cmd('request_launch','id-1'));
 assert.equal(response.approved,true);
 assert.equal(response.result.realProcess,true);
 assert.equal('grantId' in response,false);
 assert.equal(f.kernel.activeSpaces.length,1);
 assert.equal(f.commands.length,1);
 assert.equal(f.commands[0].operation,'launch');
 f.session.disconnect();
 assert.equal(f.killed,1);
});
test('denied local approval never launches a process',async()=>{
 const f=fixture(()=>false);
 const response=await f.session.request(cmd('request_launch','id-2'));
 assert.equal(response.approved,false);
 assert.equal(f.kernel.activeSpaces.length,0);
});
test('remote request_control cannot obtain permission or type through the transport',async()=>{
 const f=fixture(()=>true);
 await f.session.request(cmd('request_launch','id-3'));
 const result=await f.session.request(cmd('request_control','id-4'));
 assert.equal(result.unavailable,true);
 assert.equal(result.approved,false);
 assert.equal('grantId' in result,false);
});
test('disconnect while native prompt pending denies late approval',async()=>{
 let release;
 const decision=new Promise(resolve=>{release=resolve});
 const f=fixture(()=>decision);
 const pending=f.session.request(cmd('request_launch','id-5'));
 await new Promise(resolve=>setImmediate(resolve));
 f.session.disconnect();
 release(true);
 await assert.rejects(pending,/disconnected/);
 assert.equal(f.kernel.activeSpaces.length,0);
});
