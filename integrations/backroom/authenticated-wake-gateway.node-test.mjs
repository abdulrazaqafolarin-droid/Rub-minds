import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createAuthenticatedWakeGateway} from './authenticated-wake-gateway.mjs';

const hostId='40000000-0000-4000-8000-000000000099';
const bindingId='40000000-0000-4000-8000-000000000088';
const ownerId='40000000-0000-4000-8000-000000000077';
const sessionDigest='a'.repeat(64);
const token='b'.repeat(64);
const credentialDigest=createHash('sha256').update(token).digest('hex');
const expiresAt='2030-01-01T00:00:00.000Z';
const scope={hostId,hostToken:token,bindingId,sessionDigest};
function setup({host={},binding={},now=()=>Date.parse('2026-10-29T00:00:00Z'),activateBinding=async()=>true,deactivateBinding=async()=>true}={}) {
 const calls=[];
 const hostRecord={hostId,ownerId,credentialDigest,expiresAt,revokedAt:null,...host};
 const bindingRecord={bindingId,hostId,ownerId,sessionDigest,wakeEnabled:true,confirmedAt:'2026-10-28T00:00:00Z',wakeExpiresAt:expiresAt,revokedAt:null,...binding};
 const store={
  claim:async args=>{calls.push(['claim',args]);return [];},
  acknowledge:async args=>{calls.push(['acknowledge',args]);return true;},
  retry:async args=>{calls.push(['retry',args]);return 'pending';}
 };
 return {calls,gateway:createAuthenticatedWakeGateway({
   lookupHost:async id=>id===hostId?hostRecord:null,
   lookupBinding:async id=>id===bindingId?bindingRecord:null,store,activateBinding,deactivateBinding,now
 })};
}
test('authenticated claims, acknowledgements, retries are scoped to DB-authoritative identities',async()=>{
 const {gateway,calls}=setup();
 assert.deepEqual(await gateway.claim({...scope,limit:2}),{ok:true,leases:[]});
 assert.deepEqual(await gateway.acknowledge({...scope,jobId:'job-id',leaseToken:'lease',outcome:'ignored'}),{ok:true,accepted:true});
 assert.deepEqual(await gateway.retry({...scope,jobId:'job-id',leaseToken:'lease',errorCode:'provider_busy',retryAfterSeconds:5}),{ok:true,state:'pending'});
 assert.equal(calls.length,3);
 assert.deepEqual(calls[0][1],{hostId,bindingId,sessionDigest,limit:2});
 assert.equal(calls[1][1].hostToken,undefined);
});
test('wrong token, host, binding, session digest denied without private RPC',async()=>{
 const {gateway,calls}=setup();
 for(const input of [{...scope,hostToken:'c'.repeat(64)},{...scope,hostId:ownerId},{...scope,bindingId:ownerId},{...scope,sessionDigest:'f'.repeat(64)},{...scope,hostToken:'invalid'}]){
  assert.deepEqual(await gateway.claim(input),{ok:false,reason:'unauthorized'});
 }
 assert.equal(calls.length,0);
});
test('revoked, expired, unconfirmed or differently owned host/binding denied',async()=>{
 for(const option of [
  {host:{revokedAt:'2026-10-28T00:00:00Z'}},
  {host:{expiresAt:'2026-10-28T00:00:00Z'}},
  {host:{credentialDigest:'f'.repeat(64)}},
  {binding:{revokedAt:'2026-10-28T00:00:00Z'}},
  {binding:{wakeExpiresAt:'2026-10-28T00:00:00Z'}},
  {binding:{wakeEnabled:false}},
  {binding:{confirmedAt:null}},
  {binding:{ownerId:bindingId}},
  {binding:{hostId:bindingId}},
 ]){
  const {gateway,calls}=setup(option);
  assert.deepEqual(await gateway.claim(scope),{ok:false,reason:'unauthorized'});
  assert.equal(calls.length,0);
 }
});
test('invalid claim limit rejected after authentication',async()=>{
 const {gateway,calls}=setup();
 await assert.rejects(()=>gateway.claim({...scope,limit:21}),/limit/);
 assert.equal(calls.length,0);
});

test('inactive consent can only be activated by a correctly authenticated host for a short grant',async()=>{
 const calls=[];
 const bindingRecord={bindingId,hostId,ownerId,sessionDigest,wakeEnabled:false,
  confirmedAt:null,wakeExpiresAt:null,revokedAt:null};
 const gateway=createAuthenticatedWakeGateway({
  lookupHost:async()=>({hostId,ownerId,credentialDigest,expiresAt,revokedAt:null}),
  lookupBinding:async()=>bindingRecord,
  store:{claim:async()=>[],acknowledge:async()=>false,retry:async()=>null},
  activateBinding:async value=>{calls.push(value);return true;},
  now:()=>Date.parse('2026-10-29T00:00:00Z'),
 });
 const grantId='40000000-0000-4000-8000-000000000066';
 assert.deepEqual(await gateway.claim(scope),{ok:false,reason:'unauthorized'});
 assert.deepEqual(await gateway.activate({...scope,grantId,ttlSeconds:300}),{ok:true,activated:true});
 assert.equal(calls.length,1);
 assert.equal(calls[0].hostToken,undefined);
 assert.equal(calls[0].ttlSeconds,300);
 assert.deepEqual(await gateway.activate({...scope,hostToken:'c'.repeat(64),grantId,ttlSeconds:300}),{ok:false,reason:'unauthorized'});
 await assert.rejects(()=>gateway.activate({...scope,grantId,ttlSeconds:901}),/grant/);
 assert.equal(calls.length,1);
});

test('deactivation is bound to the authenticated host and exact one-time grant',async()=>{
 const calls=[];
 const grantId='40000000-0000-4000-8000-000000000066';
 const {gateway}=setup({deactivateBinding:async input=>{
  calls.push(input);
  return input.grantId===grantId;
 }});
 assert.deepEqual(await gateway.deactivate({...scope,grantId}),{ok:true,deactivated:true});
 assert.equal(calls.length,1);
 assert.equal(calls[0].hostToken,undefined);
 assert.deepEqual(await gateway.deactivate({...scope,grantId:'40000000-0000-4000-8000-000000000067'}),{ok:true,deactivated:false});
 assert.equal(calls.length,2);
 assert.deepEqual(await gateway.deactivate({...scope,hostToken:'c'.repeat(64),grantId}),{ok:false,reason:'unauthorized'});
 assert.equal(calls.length,2);
 await assert.rejects(()=>gateway.deactivate({...scope,grantId:'not-a-uuid'}),/grant ID/);
 assert.equal(calls.length,2);
});
