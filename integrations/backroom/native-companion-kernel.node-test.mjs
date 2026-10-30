import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createNativeCompanionKernel} from './native-companion-kernel.mjs';
const terminal={roomId:'room-1',spaceId:'space-1',appId:'shell-1',surface:'terminal',identityFingerprint:'signed-terminal-1'};
const desktop={...terminal,spaceId:'space-2',appId:'app-1',surface:'desktop_app',identityFingerprint:'signed-desktop-1'};
const catalog=()=>[
  {id:'shell-1',fingerprint:'signed-terminal-1',terminal:true,shell:'/bin/bash',args:[]},
  {id:'app-1',fingerprint:'signed-desktop-1',path:'/usr/bin/gedit',args:[]},
];
test('cannot launch without an authenticated companion connection or local approval',async()=>{
 const kernel=createNativeCompanionKernel({inventory:catalog});
 await assert.rejects(kernel.requestLaunch(terminal),/connection/);
 const connected=createNativeCompanionKernel({inventory:catalog,isDeviceConnected:()=>true,
   createPty:async()=>({kill(){},write(){},resize(){}})});
 await assert.rejects(connected.launch({scope:terminal,grantId:'unapproved'}),/permission/);
 const request=await connected.requestLaunch(terminal);
 assert.throws(()=>connected.permissions.confirm({requestId:request.id,approved:true}),/Local device/);
});
test('native approved terminal launches, interactive writes require separate control approval',async()=>{
 const written=[];let killed=false;
 const kernel=createNativeCompanionKernel({inventory:catalog,isDeviceConnected:()=>true,
   createPty:async ({onData})=>({kill(){killed=true},write(s){written.push(s);onData('real terminal output')},resize(){}}),
   onOutput:row=>assert.equal(row.data,'real terminal output')});
 const r=await kernel.requestLaunch(terminal);
 const g=kernel.permissions.confirm({requestId:r.id,approved:true,trustedLocalDecision:true});
 assert.deepEqual(await kernel.launch({scope:terminal,grantId:g.grantId}),{spaceId:'space-1',type:'terminal',realProcess:true});
 assert.throws(()=>kernel.writeTerminal({scope:terminal,grantId:g.grantId,text:'ls\r'}),/permission/);
 const ctrl=await kernel.requestCapability(terminal,'control');
 const approved=kernel.permissions.confirm({requestId:ctrl.id,approved:true,trustedLocalDecision:true});
 assert.equal(kernel.writeTerminal({scope:terminal,grantId:approved.grantId,text:'ls\r'}).submitted,true);
 assert.deepEqual(written,['ls\r']);
 assert.throws(()=>kernel.writeTerminal({scope:terminal,grantId:approved.grantId,text:'pwd\r'}),/permission/);
 assert.deepEqual(kernel.close(terminal),{closed:true});assert.equal(killed,true);
});
test('desktop executable must match verified inventory and cannot be shell interpreted',async()=>{
 const launches=[];
 const kernel=createNativeCompanionKernel({inventory:catalog,isDeviceConnected:()=>true,
  spawnProcess:(path,args,options)=>{launches.push({path,args,options});return new EventEmitter();}});
 const challenge=await kernel.requestLaunch(desktop);
 const approval=kernel.permissions.confirm({requestId:challenge.id,approved:true,trustedLocalDecision:true});
 await kernel.launch({scope:desktop,grantId:approval.grantId});
 assert.equal(launches.length,1);assert.equal(launches[0].options.shell,false);
 await assert.rejects(kernel.requestLaunch({...desktop,identityFingerprint:'wrong'}),/identity changed/);
});
test('emergency stop revokes all permissions and active PTY processes',async()=>{
 let killed=0;
 const kernel=createNativeCompanionKernel({inventory:catalog,isDeviceConnected:()=>true,
   createPty:async()=>({kill(){killed++},write(){},resize(){}})});
 const req=await kernel.requestLaunch(terminal);
 const grant=kernel.permissions.confirm({requestId:req.id,approved:true,trustedLocalDecision:true});
 await kernel.launch({scope:terminal,grantId:grant.grantId});
 assert.deepEqual(kernel.emergencyStop(),{stopped:true});
 assert.equal(killed,1);assert.equal(kernel.activeSpaces.length,0);
 await assert.rejects(kernel.requestLaunch(terminal),/connection/);
});
