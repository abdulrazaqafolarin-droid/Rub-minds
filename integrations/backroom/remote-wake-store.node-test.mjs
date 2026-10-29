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
const scope={hostId,bindingId,sessionDigest};
function setup(token=hostToken) {
 const calls=[];
 const db={
  claim:async x=>{calls.push(['claim',x]);return [{...x,jobId,leaseToken}];},
  acknowledge:async x=>{calls.push(['ack',x]);return true;},
  retry:async x=>{calls.push(['retry',x]);return 'pending';}
 };
 const gateway=createAuthenticatedWakeGateway({
  lookupHost:async()=>({hostId,ownerId,credentialDigest:createHash('sha256').update(hostToken).digest('hex'),expiresAt:'2030-01-01T00:00:00Z',revokedAt:null}),
  lookupBinding:async()=>({bindingId,hostId,ownerId,sessionDigest,revokedAt:null,wakeEnabled:true,confirmedAt:'2026-10-29T00:00:00Z',wakeExpiresAt:'2030-01-01T00:00:00Z'}),
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
 assert.deepEqual(calls[0],['claim',{...scope,limit:2}]);
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
