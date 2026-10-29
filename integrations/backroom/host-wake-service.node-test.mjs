import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHostWakeService} from './host-wake-service.mjs';

const hostId='40000000-0000-4000-8000-000000000011';
const bindingId='40000000-0000-4000-8000-000000000022';
const sessionDigest='a'.repeat(64);
const hostToken='b'.repeat(64);
const trustedUrl='https://zucaeevlbwhcvjwbhwmq.supabase.co/functions/v1/backroom-wake/';
function runtime(){
 return {hostId,running:true,dispatcher:{enqueue(){},step(){},status(){}},
  verifyRemoteWakeActivation:async()=>true,
  resolveClaimedWakeContext:async()=>null,
  verifyClaimedWakeGrant:async()=>false};
}
test('host service rejects attacker-selected HTTPS URL before constructing a remote store',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'backroom-pinned-gateway-'));
 try{
  let calls=0;
  assert.throws(()=>createHostWakeService({
   identity:{hostId,hostToken},browserRuntime:runtime(),
   journalDirectory:join(dir,'journal'),gatewayUrl:'https://attacker.example/functions/v1/backroom-wake/',
   fetchImpl:async()=>{calls++;}
  }),/trusted Supabase endpoint/);
  assert.equal(calls,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('paired browser configuration cannot override the credential destination',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'backroom-reconfigure-deny-'));
 try{
  let calls=0;
  const service=createHostWakeService({
   identity:{hostId,hostToken},browserRuntime:runtime(),
   journalDirectory:join(dir,'journal'),gatewayUrl:trustedUrl,
   fetchImpl:async()=>{calls++;return new Response(JSON.stringify({ok:true,activated:true}),{status:200});}
  });
  assert.throws(()=>service.configure({gatewayUrl:'https://attacker.example/',sessionDigest,bindingId}),/Only binding ID/);
  assert.throws(()=>service.configure({url:'https://attacker.example/',sessionDigest,bindingId}),/Only binding ID/);
  assert.equal(calls,0);
  const configured=service.configure({sessionDigest,bindingId});
  assert.deepEqual(configured,{configured:true,bindingId});
  assert.equal(service.status.configured,true);
  assert.equal(calls,0);
  await service.stop();
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('local host credential is sent only to the trusted Supabase Edge Function',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'backroom-pinned-request-'));
 try{
  const urls=[],headers=[];
  const service=createHostWakeService({
   identity:{hostId,hostToken},browserRuntime:runtime(),
   journalDirectory:join(dir,'journal'),gatewayUrl:trustedUrl,
   fetchImpl:async(url,options)=>{
    urls.push(url);headers.push(options.headers);
    return new Response(JSON.stringify({ok:true,activated:true}),{status:200});
   }
  });
  service.configure({sessionDigest,bindingId});
  const grantId='40000000-0000-4000-8000-000000000033';
  await service.activateAndStart({grantId,scope:{hostId,bindingId,groupId:'40000000-0000-4000-8000-000000000044',
    participantId:'40000000-0000-4000-8000-000000000055',sessionId:'40000000-0000-4000-8000-000000000066'}},
   {bindingId,roomId:'40000000-0000-4000-8000-000000000044',
    participantId:'40000000-0000-4000-8000-000000000055',sessionId:'40000000-0000-4000-8000-000000000066'});
  assert.deepEqual(urls,[trustedUrl+'activate']);
  assert.equal(headers[0].Authorization,'Bearer '+hostToken);
  await service.stop();
 }finally{await rm(dir,{recursive:true,force:true});}
});
