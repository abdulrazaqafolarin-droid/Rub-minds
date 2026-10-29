import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createBackroomHostServer } from '../../scripts/backroom-host-server.mjs';

const origin='https://rub-minds.vercel.app';
function fakeBrowser(){return {status:()=>({running:false,pages:0,capabilities:{}}),stop:async()=>({running:false}),listPages:async()=>[],listTargets:async()=>[]};}

test('paired loopback host mounts authenticated workspace routes and preserves task scope',async()=>{
 let received=null;
 const runtime={
  status:()=>({stopped:false,capabilities:{desktop:false,android:true,terminal:false}}),
  runAndroidTask:async input=>{received=input;return {traceId:'trace-1',status:'running',deviceSerial:input.deviceSerial,groupId:input.groupId,sessionId:input.sessionId};},
  stop:async()=>({stopped:true,closeFailures:0}),
 };
 const instance=createBackroomHostServer({hostId:randomUUID(),port:0,allowedOrigins:[origin],browserRuntime:fakeBrowser(),externalWorkspaceRuntime:runtime});
 const address=await instance.start();
 try{
  const base='http://127.0.0.1:'+address.port;
  const pairResponse=await fetch(base+'/v1/pair',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({pairingCode:instance.pairingCode,clientLabel:'workspace integration test'})});
  assert.equal(pairResponse.status,200);
  const pairing=await pairResponse.json();
  assert.equal(typeof pairing.sessionToken,'string');
  const status=await fetch(base+'/v1/workspaces/status',{headers:{origin,authorization:'Bearer '+pairing.sessionToken}});
  assert.equal(status.status,200);
  assert.equal((await status.json()).capabilities.android,true);
  const body={groupId:'group-A',sessionId:'session-A',deviceSerial:'emulator-1',appPackage:'com.example.app',task:'Read current app state'};
  const res=await fetch(base+'/v1/workspaces/android/tasks',{method:'POST',headers:{origin,authorization:'Bearer '+pairing.sessionToken,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal(res.status,201);
  const result=await res.json();assert.equal(result.traceId,'trace-1');
  assert.equal(received.groupId,'group-A');assert.equal(received.sessionId,'session-A');
  const forbidden=await fetch(base+'/v1/workspaces/android/tasks',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal(forbidden.status,401);
  const injected=await fetch(base+'/v1/workspaces/android/tasks',{method:'POST',headers:{origin,authorization:'Bearer '+pairing.sessionToken,'content-type':'application/json'},body:JSON.stringify({...body,hostToken:'do-not-accept'})});
  assert.equal(injected.status,400);
 }finally{await instance.close();}
});
