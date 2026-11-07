import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRemoteWakeStore} from './remote-wake-store.mjs';
import {createAuthenticatedWakeGateway} from './authenticated-wake-gateway.mjs';
import {createWakeGatewayHttpHandler} from './wake-gateway-http.mjs';
const hostId='40000000-0000-4000-8000-000000000011';
const bindingId='40000000-0000-4000-8000-000000000022';
const ownerId='40000000-0000-4000-8000-000000000033';
const jobId='40000000-0000-4000-8000-000000000044';
const leaseToken='40000000-0000-4000-8000-000000000055';
const sessionDigest='a'.repeat(64),hostToken='b'.repeat(64);
const providerConversationIdentityDigest='c'.repeat(64);
const scope={hostId,bindingId,sessionDigest};
function setup(token=hostToken) {
 const calls=[];
 const db={
  claim:async x=>{calls.push(['claim',x]);return [{...x,jobId,leaseToken,providerConversationIdentityDigest}];},
  acknowledge:async x=>{calls.push(['ack',x]);return true;},
  retry:async x=>{calls.push(['retry',x]);return 'pending';}
 };
 const gateway=createAuthenticatedWakeGateway({
  lookupHost:async()=>({hostId,ownerId,credentialDigest:createHash('sha256').update(hostToken).digest('hex'),expiresAt:'2030-01-01T00:00:00Z',revokedAt:null}),
  lookupBinding:async()=>({bindingId,hostId,ownerId,sessionDigest,surface:'android_app',providerConversationIdentityDigest,nativeBindingAttested:true,revokedAt:null,wakeEnabled:true,confirmedAt:'2026-10-29T00:00:00Z',wakeExpiresAt:'2030-01-01T00:00:00Z'}),
  store:db,now:()=>Date.parse('2026-10-29T12:00:00Z')
 });
 const handler=createWakeGatewayHttpHandler({gateway});
 const fetchImpl=async(url,options)=>handler(new Request(url,options));
 return {store:createRemoteWakeStore({baseUrl:'https://wake.example.test/',hostToken:token,fetchImpl}),calls};
}
test('host HTTPS claim -> authenticated gateway -> private store and back',async()=>{
 const {store,calls}=setup();
 const leases=await store.claim({...scope,limit:2});
 assert.equal(leases.length,1);
 assert.equal(leases[0].jobId,jobId);
 assert.equal(leases[0].providerConversationIdentityDigest,providerConversationIdentityDigest);
 assert.deepEqual(calls[0],['claim',{...scope,surface:'android_app',limit:2,providerConversationIdentityDigest}]);
 assert.equal(await store.acknowledge({...scope,jobId,leaseToken}),true);
 assert.equal(await store.retry({...scope,jobId,leaseToken,errorCode:'provider_busy'}),'pending');
 assert.deepEqual(calls.map(x=>x[0]),['claim','ack','retry']);
});
test('wrong host token is denied end-to-end before privileged store access',async()=>{
 const {store,calls}=setup('c'.repeat(64));
 await assert.rejects(()=>store.claim(scope),/unavailable or unauthorized/);
 assert.equal(calls.length,0);
});
test('client blocks insecure URLs, malformed scopes and spoofed response leases',async()=>{
 assert.throws(()=>createRemoteWakeStore({baseUrl:'http://wake.example.test/',hostToken}),/HTTPS/);
 assert.throws(()=>createRemoteWakeStore({baseUrl:'https://user:pass@wake.example.test/',hostToken}),/HTTPS/);
 const {store,calls}=setup();
 await assert.rejects(()=>store.claim({...scope,hostId:'wrong'}),/scope/);
 assert.equal(calls.length,0);
 const forged=createRemoteWakeStore({baseUrl:'https://wake.example.test/',hostToken,
  fetchImpl:async()=>new Response(JSON.stringify({ok:true,leases:[{hostId:ownerId,bindingId,sessionDigest}]}),{status:200})});
 await assert.rejects(()=>forged.claim(scope),/Cross-scope/);
});

test('malformed provider-conversation digest in a remote lease is rejected',async()=>{
 const forged=createRemoteWakeStore({baseUrl:'https://wake.example.test/',hostToken,
  fetchImpl:async()=>new Response(JSON.stringify({ok:true,leases:[{
   ...scope,jobId,leaseToken,providerConversationIdentityDigest:'not-a-sha256-digest'
  }]}),{status:200})});
 await assert.rejects(()=>forged.claim(scope),/provider-conversation identity digest/);
});

test('official Supabase Edge Function URL retains bearer and exact scoped route',async()=>{
 const {store,calls}=setup();
 const actual=[];
 const alternate=createRemoteWakeStore({
  baseUrl:'https://project-ref.supabase.co/functions/v1/backroom-wake/',
  hostToken,
  fetchImpl:async(url,options)=>{
   actual.push(url);
   const gateway=createAuthenticatedWakeGateway({
    lookupHost:async()=>({hostId,ownerId,credentialDigest:createHash('sha256').update(hostToken).digest('hex'),expiresAt:'2030-01-01T00:00:00Z',revokedAt:null}),
    lookupBinding:async()=>({bindingId,hostId,ownerId,sessionDigest,surface:'android_app',providerConversationIdentityDigest,nativeBindingAttested:true,revokedAt:null,wakeEnabled:true,confirmedAt:'2026-10-29T00:00:00Z',wakeExpiresAt:'2030-01-01T00:00:00Z'}),
    store:{claim:async x=>[{...x,jobId,leaseToken}],acknowledge:async()=>true,retry:async()=> 'pending'},
    now:()=>Date.parse('2026-10-29T12:00:00Z')
   });
   return createWakeGatewayHttpHandler({gateway})(new Request(url,options));
  }
 });
 const leases=await alternate.claim(scope);
 assert.equal(leases.length,1);
 assert.equal(actual[0],'https://project-ref.supabase.co/functions/v1/backroom-wake/claim');
 assert.equal(calls.length,0);
});

test('remote activation requires a locally verified grant before contacting hosted API',async()=>{
 const grantId='40000000-0000-4000-8000-000000000066';
 let requests=0;
 const denied=createRemoteWakeStore({baseUrl:'https://wake.example.test/',hostToken,
  verifyLocalGrant:async()=>false,
  fetchImpl:async()=>{requests++;throw new Error('No request expected');}
 });
 await assert.rejects(()=>denied.activate({...scope,grantId,ttlSeconds:300}),/not verified/);
 const missing=createRemoteWakeStore({baseUrl:'https://wake.example.test/',hostToken,
  fetchImpl:async()=>{requests++;throw new Error('No request expected');}
 });
 await assert.rejects(()=>missing.activate({...scope,grantId,ttlSeconds:300}),/verifier/);
 assert.equal(requests,0);
 const records=[];
 const gateway=createAuthenticatedWakeGateway({
  lookupHost:async()=>({hostId,ownerId,credentialDigest:createHash('sha256').update(hostToken).digest('hex'),
   expiresAt:'2030-01-01T00:00:00Z',revokedAt:null}),
  lookupBinding:async()=>({bindingId,hostId,ownerId,sessionDigest,surface:'browser_tab',wakeEnabled:false,confirmedAt:null,
   wakeExpiresAt:null,revokedAt:null}),
  store:{claim:async()=>[],acknowledge:async()=>false,retry:async()=>null},
  activateBinding:async info=>{records.push(info);return true;},
  now:()=>Date.parse('2026-10-29T00:00:00Z')
 });
 const handler=createWakeGatewayHttpHandler({gateway});
 const accepted=createRemoteWakeStore({baseUrl:'https://wake.example.test/',hostToken,
  verifyLocalGrant:async approval=>approval.grantId===grantId,
  fetchImpl:async(url,options)=>handler(new Request(url,options))
 });
 assert.equal(await accepted.activate({...scope,grantId,ttlSeconds:86400}),true);
 assert.equal(records.length,1);
 assert.equal(records[0].hostId,hostId);
 await assert.rejects(()=>accepted.activate({...scope,grantId,ttlSeconds:86401}),/grant/);
});

test('Supabase publishable key is sent in apikey header while private host token stays in Authorization',async()=>{
 const apiKey='sb_publishable_exampleKey0123456789abcdef';
 const url='https://zucaeevlbwhcvjwbhwmq.supabase.co/functions/v1/backroom-wake/';
 const seen=[];
 const store=createRemoteWakeStore({baseUrl:url,hostToken,apiKey,
  fetchImpl:async(href,options)=>{
   seen.push({href,headers:options.headers,body:options.body});
   return new Response(JSON.stringify({ok:true,leases:[]}),{status:200});
  }});
 assert.deepEqual(await store.claim(scope),[]);
 assert.equal(seen[0].href,url+'claim');
 assert.equal(seen[0].headers.apikey,apiKey);
 assert.equal(seen[0].headers.Authorization,'Bearer '+hostToken);
 assert.equal(seen[0].body.includes(hostToken),false);
 assert.equal(seen[0].body.includes(apiKey),false);
 assert.throws(()=>createRemoteWakeStore({baseUrl:url,hostToken,apiKey:'bad key'}),/public Supabase/);
});
