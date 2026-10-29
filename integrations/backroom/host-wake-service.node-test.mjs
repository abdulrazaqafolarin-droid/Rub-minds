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
const publishableKey='sb_publishable_exampleKey0123456789abcdef';
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
  assert.throws(()=>service.configure({gatewayUrl:'https://attacker.example/',sessionDigest,bindingId}),/Unexpected host configuration fields/);
  assert.throws(()=>service.configure({url:'https://attacker.example/',sessionDigest,bindingId}),/Unexpected host configuration fields/);
  assert.equal(calls,0);
  const configured=service.configure({sessionDigest,bindingId,publishableKey});
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
    const data=url.endsWith('/activate')?{ok:true,activated:true}:
      url.endsWith('/deactivate')?{ok:true,deactivated:true}:{ok:true,leases:[]};
    return new Response(JSON.stringify(data),{status:200});
   }
  });
  service.configure({sessionDigest,bindingId});
  const grantId='40000000-0000-4000-8000-000000000033';
  await service.activateAndStart({grantId,expiresAt:Date.now()+300000,scope:{hostId,bindingId,groupId:'40000000-0000-4000-8000-000000000044',
    participantId:'40000000-0000-4000-8000-000000000055',sessionId:'40000000-0000-4000-8000-000000000066'}},
   {bindingId,roomId:'40000000-0000-4000-8000-000000000044',
    participantId:'40000000-0000-4000-8000-000000000055',sessionId:'40000000-0000-4000-8000-000000000066'});
  assert.equal(urls[0],trustedUrl+'activate');
  assert.equal(headers[0].Authorization,'Bearer '+hostToken);
  assert.equal(headers[0].apikey,publishableKey);
  await new Promise(resolve=>setTimeout(resolve,0));
  await service.stop();
  assert.ok(urls.includes(trustedUrl+'deactivate'));
  assert.ok(urls.every(url=>url.startsWith(trustedUrl)));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('lost activation response retries only the same consent grant and can then be revoked',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'backroom-activation-retry-'));
 try{
  const urls=[],payloads=[];let activations=0;
  const service=createHostWakeService({
   identity:{hostId,hostToken},browserRuntime:runtime(),
   journalDirectory:join(dir,'journal'),gatewayUrl:trustedUrl,
   fetchImpl:async(url,options)=>{
    urls.push(url);payloads.push(JSON.parse(options.body));
    if(url.endsWith('/activate') && ++activations===1)throw new Error('simulate lost HTTP response');
    const body=url.endsWith('/activate')?{ok:true,activated:true}:
      url.endsWith('/deactivate')?{ok:true,deactivated:true}:{ok:true,leases:[]};
    return new Response(JSON.stringify(body),{status:200});
   }
  });
  service.configure({sessionDigest,bindingId});
  const grantId='40000000-0000-4000-8000-000000000077';
  const grant={grantId,expiresAt:Date.now()+300000,scope:{
   hostId,bindingId,groupId:'40000000-0000-4000-8000-000000000044',
   participantId:'40000000-0000-4000-8000-000000000055',
   sessionId:'40000000-0000-4000-8000-000000000066'
  }};
  const input={bindingId,roomId:grant.scope.groupId,participantId:grant.scope.participantId,sessionId:grant.scope.sessionId};
  await service.activateAndStart(grant,input);
  assert.equal(activations,2);
  assert.equal(payloads[0].grantId,grantId);
  assert.equal(payloads[1].grantId,grantId);
  assert.equal(payloads[0].ttlSeconds,payloads[1].ttlSeconds);
  assert.ok(payloads[0].ttlSeconds>=60&&payloads[0].ttlSeconds<=295);
  await new Promise(resolve=>setTimeout(resolve,0));
  await service.stop();
  assert.ok(urls.includes(trustedUrl+'deactivate'));
  assert.ok(urls.every(url=>url.startsWith(trustedUrl)));
 }finally{await rm(dir,{recursive:true,force:true});}
});
