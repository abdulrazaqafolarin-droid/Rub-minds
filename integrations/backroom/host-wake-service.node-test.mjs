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
  assert.deepEqual(configured,{configured:true,bindingId,existing:false});
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
  service.configure({sessionDigest,bindingId,publishableKey});
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
  service.configure({sessionDigest,bindingId,publishableKey});
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

test('multiple AI bindings poll independently and targeted revoke leaves sibling active',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'backroom-multi-binding-'));
 try{
  const urls=[],bodies=[],headers=[];
  const service=createHostWakeService({
   identity:{hostId,hostToken},browserRuntime:runtime(),
   journalDirectory:join(dir,'journal'),gatewayUrl:trustedUrl,
   fetchImpl:async(url,options)=>{
    urls.push(url);bodies.push(JSON.parse(options.body));headers.push(options.headers);
    const body=url.endsWith('/activate')?{ok:true,activated:true}:
      url.endsWith('/deactivate')?{ok:true,deactivated:true}:{ok:true,leases:[]};
    return new Response(JSON.stringify(body),{status:200});
   }
  });
  const binding2='40000000-0000-4000-8000-000000000099';
  const digest2='c'.repeat(64);
  service.configure({sessionDigest,bindingId,publishableKey});
  service.configure({sessionDigest:digest2,bindingId:binding2,publishableKey});
  // Config retry is idempotent and must not create a duplicate poller.
  assert.deepEqual(service.configure({sessionDigest,bindingId,publishableKey}),
    {configured:true,bindingId,existing:true});
  const grant1='40000000-0000-4000-8000-000000000071';
  const grant2='40000000-0000-4000-8000-000000000072';
  const scope1={hostId,bindingId,groupId:'40000000-0000-4000-8000-000000000081',
   participantId:'40000000-0000-4000-8000-000000000091',sessionId:'40000000-0000-4000-8000-0000000000a1'};
  const scope2={hostId,bindingId:binding2,groupId:'40000000-0000-4000-8000-000000000082',
   participantId:'40000000-0000-4000-8000-000000000092',sessionId:'40000000-0000-4000-8000-0000000000a2'};
  await service.activateAndStart({grantId:grant1,expiresAt:Date.now()+300000,scope:scope1},{bindingId,roomId:scope1.groupId,participantId:scope1.participantId,sessionId:scope1.sessionId});
  await service.activateAndStart({grantId:grant2,expiresAt:Date.now()+300000,scope:scope2},{bindingId:binding2,roomId:scope2.groupId,participantId:scope2.participantId,sessionId:scope2.sessionId});
  assert.equal(service.status.count,2);
  assert.ok(service.status.bindings.every(x=>x.polling&&x.consentActive));
  const stopped=await service.stop(bindingId);
  assert.equal(stopped.bindings.length,1);
  assert.equal(stopped.bindings[0].bindingId,bindingId);
  const first=service.status.bindings.find(x=>x.bindingId===bindingId);
  const second=service.status.bindings.find(x=>x.bindingId===binding2);
  assert.equal(first.polling,false);assert.equal(first.consentActive,false);
  assert.equal(second.polling,true);assert.equal(second.consentActive,true);
  await service.stop();
  assert.ok(service.status.bindings.every(x=>!x.polling&&!x.consentActive));
  assert.ok(urls.includes(trustedUrl+'deactivate'));
  assert.ok(urls.every(url=>url.startsWith(trustedUrl)));
  assert.ok(headers.every(header=>header.apikey===publishableKey&&header.Authorization==='Bearer '+hostToken));
  assert.ok(bodies.filter(body=>body.grantId).every(body=>[grant1,grant2].includes(body.grantId)));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('a false remote deactivation response is never reported as confirmed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'backroom-deactivate-false-'));
 try{
  const service=createHostWakeService({
   identity:{hostId,hostToken},browserRuntime:runtime(),
   journalDirectory:join(dir,'journal'),gatewayUrl:trustedUrl,
   fetchImpl:async(url)=>new Response(JSON.stringify(url.endsWith('/activate')?
    {ok:true,activated:true}:url.endsWith('/deactivate')?
    {ok:true,deactivated:false}:{ok:true,leases:[]}),{status:200})
  });
  service.configure({sessionDigest,bindingId,publishableKey});
  const grantId='40000000-0000-4000-8000-000000000078';
  const groupId='40000000-0000-4000-8000-000000000044';
  const participantId='40000000-0000-4000-8000-000000000055';
  const sessionId='40000000-0000-4000-8000-000000000066';
  await service.activateAndStart({grantId,expiresAt:Date.now()+300000,scope:{
    hostId,bindingId,groupId,participantId,sessionId
   }},{bindingId,roomId:groupId,participantId,sessionId});
  const result=await service.stop(bindingId);
  assert.equal(result.stopped,true);
  assert.equal(result.remotelyDeactivated,false);
  assert.equal(result.bindings[0].remotelyDeactivated,false);
  const status=service.status.bindings.find(item=>item.bindingId===bindingId);
  assert.equal(status.polling,false);
  assert.equal(status.consentActive,false);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('unconfigure keeps a retry handle until remote deactivation is confirmed',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'backroom-unconfigure-pending-'));
 try{
  let deactivationCalls=0;
  const service=createHostWakeService({
   identity:{hostId,hostToken},browserRuntime:runtime(),
   journalDirectory:join(dir,'journal'),gatewayUrl:trustedUrl,
   fetchImpl:async(url)=>{
    if(url.endsWith('/activate'))return new Response(JSON.stringify({ok:true,activated:true}),{status:200});
    if(url.endsWith('/deactivate')){
     deactivationCalls++;
     if(deactivationCalls<=2)throw new Error('temporary remote outage');
     return new Response(JSON.stringify({ok:true,deactivated:true}),{status:200});
    }
    return new Response(JSON.stringify({ok:true,leases:[]}),{status:200});
   }
  });
  service.configure({sessionDigest,bindingId,publishableKey});
  const grantId='40000000-0000-4000-8000-0000000000ab';
  const groupId='40000000-0000-4000-8000-000000000044';
  const participantId='40000000-0000-4000-8000-000000000055';
  const sessionId='40000000-0000-4000-8000-000000000066';
  await service.activateAndStart({grantId,expiresAt:Date.now()+300000,
   scope:{hostId,bindingId,groupId,participantId,sessionId}},
   {bindingId,roomId:groupId,participantId,sessionId});
  const first=await service.unconfigure(bindingId);
  assert.deepEqual(first,{removed:false,bindingId,remotelyDeactivated:false,retryPending:true});
  assert.equal(deactivationCalls,2);
  assert.deepEqual(service.status.bindings.find(item=>item.bindingId===bindingId),{
   bindingId,polling:false,consentActive:true,deactivationPending:true
  });
  const second=await service.unconfigure(bindingId);
  assert.deepEqual(second,{removed:true,bindingId,remotelyDeactivated:true,retryPending:false});
  assert.equal(deactivationCalls,3);
  assert.equal(service.status.configured,false);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('concurrent activation for one grant shares one server transaction',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'backroom-activation-race-'));
 try{
  let activationCalls=0,releaseActivation;
  const activationGate=new Promise(resolve=>{releaseActivation=resolve;});
  const service=createHostWakeService({
   identity:{hostId,hostToken},browserRuntime:runtime(),
   journalDirectory:join(dir,'journal'),gatewayUrl:trustedUrl,
   fetchImpl:async(url,options)=>{
    if(url.endsWith('/activate')){
     activationCalls++;
     await activationGate;
     return new Response(JSON.stringify({ok:true,activated:true}),{status:200});
    }
    if(url.endsWith('/deactivate'))return new Response(JSON.stringify({ok:true,deactivated:true}),{status:200});
    return new Response(JSON.stringify({ok:true,leases:[]}),{status:200});
   }
  });
  service.configure({sessionDigest,bindingId,publishableKey});
  const grantId='40000000-0000-4000-8000-000000000079';
  const groupId='40000000-0000-4000-8000-000000000044';
  const participantId='40000000-0000-4000-8000-000000000055';
  const sessionId='40000000-0000-4000-8000-000000000066';
  const grant={grantId,expiresAt:Date.now()+300000,scope:{hostId,bindingId,groupId,participantId,sessionId}};
  const input={bindingId,roomId:groupId,participantId,sessionId};
  const first=service.activateAndStart(grant,input);
  const second=service.activateAndStart(grant,input);
  await Promise.resolve();
  assert.equal(activationCalls,1);
  releaseActivation();
  const results=await Promise.all([first,second]);
  assert.equal(results.length,2);
  assert.ok(results.every(result=>result.activated===true));
  assert.equal(activationCalls,1);
  await new Promise(resolve=>setTimeout(resolve,0));
  await service.stop();
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('different grants cannot race the same binding while activation is pending',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'backroom-different-grant-race-'));
 try{
  let releaseActivation,activationCalls=0;
  const activationGate=new Promise(resolve=>{releaseActivation=resolve;});
  const service=createHostWakeService({
   identity:{hostId,hostToken},browserRuntime:runtime(),
   journalDirectory:join(dir,'journal'),gatewayUrl:trustedUrl,
   fetchImpl:async(url)=>{
    if(url.endsWith('/activate')){activationCalls++;await activationGate;return new Response(JSON.stringify({ok:true,activated:true}),{status:200});}
    if(url.endsWith('/deactivate'))return new Response(JSON.stringify({ok:true,deactivated:true}),{status:200});
    return new Response(JSON.stringify({ok:true,leases:[]}),{status:200});
   }
  });
  service.configure({sessionDigest,bindingId,publishableKey});
  const groupId='40000000-0000-4000-8000-000000000044',participantId='40000000-0000-4000-8000-000000000055',sessionId='40000000-0000-4000-8000-000000000066';
  const input={bindingId,roomId:groupId,participantId,sessionId};
  const grant={grantId:'40000000-0000-4000-8000-000000000079',expiresAt:Date.now()+300000,scope:{hostId,bindingId,groupId,participantId,sessionId}};
  const other={...grant,grantId:'40000000-0000-4000-8000-000000000080'};
  const first=service.activateAndStart(grant,input);
  await assert.rejects(()=>service.activateAndStart(other,input),/already in progress/);
  assert.equal(activationCalls,1);
  releaseActivation();
  await first;
  await new Promise(resolve=>setTimeout(resolve,0));
  await service.stop();
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('two lost activation responses trigger grant-scoped cleanup before returning unknown failure',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'backroom-activation-unknown-'));
 try{
  const urls=[],payloads=[];let activationCalls=0,deactivationCalls=0;
  const service=createHostWakeService({
   identity:{hostId,hostToken},browserRuntime:runtime(),
   journalDirectory:join(dir,'journal'),gatewayUrl:trustedUrl,
   fetchImpl:async(url,options)=>{
    urls.push(url);payloads.push(JSON.parse(options.body));
    if(url.endsWith('/activate')){activationCalls++;throw new Error('simulated lost activation response');}
    if(url.endsWith('/deactivate')){deactivationCalls++;return new Response(JSON.stringify({ok:true,deactivated:true}),{status:200});}
    return new Response(JSON.stringify({ok:true,leases:[]}),{status:200});
   }
  });
  service.configure({sessionDigest,bindingId,publishableKey});
  const grantId='40000000-0000-4000-8000-000000000081';
  const groupId='40000000-0000-4000-8000-000000000044';
  const participantId='40000000-0000-4000-8000-000000000055';
  const sessionId='40000000-0000-4000-8000-000000000066';
  await assert.rejects(()=>service.activateAndStart({
   grantId,expiresAt:Date.now()+300000,
   scope:{hostId,bindingId,groupId,participantId,sessionId}
  },{bindingId,roomId:groupId,participantId,sessionId}),/simulated lost activation response/);
  assert.equal(activationCalls,2);
  assert.equal(deactivationCalls,1);
  assert.ok(payloads.filter((_,i)=>urls[i].endsWith('/activate')).every(p=>p.grantId===grantId));
  assert.ok(payloads.filter((_,i)=>urls[i].endsWith('/deactivate')).every(p=>p.grantId===grantId));
  assert.equal(service.status.bindings[0].polling,false);
  assert.equal(service.status.bindings[0].consentActive,false);
  assert.equal(service.status.bindings[0].deactivationPending,false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('if both activation and deactivation are unreachable, service preserves a deactivation-pending marker',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'backroom-activation-cleanup-pending-'));
 try{
  let activationCalls=0,deactivationCalls=0;
  const service=createHostWakeService({
   identity:{hostId,hostToken},browserRuntime:runtime(),
   journalDirectory:join(dir,'journal'),gatewayUrl:trustedUrl,
   fetchImpl:async(url)=>{
    if(url.endsWith('/activate')){activationCalls++;throw new Error('activation transport down');}
    if(url.endsWith('/deactivate')){deactivationCalls++;throw new Error('deactivation transport down');}
    return new Response(JSON.stringify({ok:true,leases:[]}),{status:200});
   }
  });
  service.configure({sessionDigest,bindingId,publishableKey});
  const grantId='40000000-0000-4000-8000-000000000082';
  const groupId='40000000-0000-4000-8000-000000000044';
  const participantId='40000000-0000-4000-8000-000000000055';
  const sessionId='40000000-0000-4000-8000-000000000066';
  await assert.rejects(()=>service.activateAndStart({
   grantId,expiresAt:Date.now()+300000,scope:{hostId,bindingId,groupId,participantId,sessionId}
  },{bindingId,roomId:groupId,participantId,sessionId}),/activation transport down/);
  assert.equal(activationCalls,2);
  assert.equal(deactivationCalls,2);
  assert.equal(service.status.bindings[0].polling,false);
  assert.equal(service.status.bindings[0].consentActive,false);
  assert.equal(service.status.bindings[0].deactivationPending,true);
  const stopped=await service.stop(bindingId);
  assert.equal(stopped.remotelyDeactivated,false);
  assert.equal(deactivationCalls,4);
 }finally{await rm(dir,{recursive:true,force:true});}
});


test('local staging environment pins the paired host wake gateway to the staging project',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'backroom-staging-gateway-env-'));
 const previous=process.env.BACKROOM_WAKE_GATEWAY_URL;
 const stagingUrl='https://tzcuuynmviiuactafpld.supabase.co/functions/v1/backroom-wake/';
 const urls=[];
 try{
  process.env.BACKROOM_WAKE_GATEWAY_URL=stagingUrl;
  const service=createHostWakeService({
   identity:{hostId,hostToken},browserRuntime:runtime(),
   journalDirectory:join(dir,'journal'),
   fetchImpl:async(url)=>{
    urls.push(url);
    const body=url.endsWith('/activate')?{ok:true,activated:true}:
      url.endsWith('/deactivate')?{ok:true,deactivated:true}:{ok:true,leases:[]};
    return new Response(JSON.stringify(body),{status:200});
   }
  });
  service.configure({sessionDigest,bindingId,publishableKey});
  assert.equal(service.status.gatewayHost,'tzcuuynmviiuactafpld.supabase.co');
  const groupId='40000000-0000-4000-8000-000000000044';
  const participantId='40000000-0000-4000-8000-000000000055';
  const sessionId='40000000-0000-4000-8000-000000000066';
  const grantId='40000000-0000-4000-8000-000000000077';
  await service.activateAndStart({grantId,expiresAt:Date.now()+300000,
   scope:{hostId,bindingId,groupId,participantId,sessionId}},
   {bindingId,roomId:groupId,participantId,sessionId});
  await service.stop();
  assert.ok(urls.includes(stagingUrl+'activate'));
  assert.ok(urls.includes(stagingUrl+'deactivate'));
  assert.ok(urls.every(url=>url.startsWith(stagingUrl)));
 }finally{
  if(previous===undefined)delete process.env.BACKROOM_WAKE_GATEWAY_URL;
  else process.env.BACKROOM_WAKE_GATEWAY_URL=previous;
  await rm(dir,{recursive:true,force:true});
 }
});


test('default local wake service reports the Production gateway host for mismatch detection',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'backroom-production-gateway-host-'));
 const previous=process.env.BACKROOM_WAKE_GATEWAY_URL;
 try{
  delete process.env.BACKROOM_WAKE_GATEWAY_URL;
  const service=createHostWakeService({
   identity:{hostId,hostToken},browserRuntime:runtime(),
   journalDirectory:join(dir,'journal'),
   fetchImpl:async()=>{throw new Error('no network request expected');}
  });
  assert.equal(service.status.gatewayHost,'zucaeevlbwhcvjwbhwmq.supabase.co');
  assert.equal(service.status.configured,false);
  await service.stop();
 }finally{
  if(previous===undefined)delete process.env.BACKROOM_WAKE_GATEWAY_URL;
  else process.env.BACKROOM_WAKE_GATEWAY_URL=previous;
  await rm(dir,{recursive:true,force:true});
 }
});

test('explicit Auto grant can activate the remote queue for the full 24-hour window',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'backroom-24h-grant-'));
 try{
  const bodies=[];
  const service=createHostWakeService({
   identity:{hostId,hostToken},browserRuntime:runtime(),
   journalDirectory:join(dir,'journal'),gatewayUrl:trustedUrl,
   fetchImpl:async(url,options)=>{
    bodies.push({url,body:JSON.parse(options.body)});
    const data=url.endsWith('/activate')?{ok:true,activated:true}:
      url.endsWith('/deactivate')?{ok:true,deactivated:true}:{ok:true,leases:[]};
    return new Response(JSON.stringify(data),{status:200});
   }
  });
  service.configure({sessionDigest,bindingId,publishableKey});
  const grantId='40000000-0000-4000-8000-0000000000bc';
  const groupId='40000000-0000-4000-8000-000000000044';
  const participantId='40000000-0000-4000-8000-000000000055';
  const sessionId='40000000-0000-4000-8000-000000000066';
  await service.activateAndStart({grantId,expiresAt:Date.now()+86_400_000,scope:{
   hostId,bindingId,groupId,participantId,sessionId
  }},{bindingId,roomId:groupId,participantId,sessionId});
  const activation=bodies.find(item=>item.url.endsWith('/activate'));
  assert.ok(activation);
  assert.ok(activation.body.ttlSeconds<=86400&&activation.body.ttlSeconds>=86380,
    'server activation receives the nearly complete 24-hour local grant lifetime');
  await service.stop();
 }finally{await rm(dir,{recursive:true,force:true});}
});
