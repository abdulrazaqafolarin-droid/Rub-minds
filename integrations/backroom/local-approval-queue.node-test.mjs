import test from 'node:test';
import assert from 'node:assert/strict';
import { createSerializedLocalApproval } from './local-approval-queue.mjs';

function deferred(){
 let resolve;
 const promise=new Promise(r=>{resolve=r;});
 return {promise,resolve};
}

test('trusted local approvals are serialized and preserve exact action order',async()=>{
 const gate=deferred(),events=[];let active=0,maxActive=0;
 const approve=createSerializedLocalApproval(async action=>{
  active++;maxActive=Math.max(maxActive,active);
  events.push('start:'+action.id);
  if(action.id==='first')await gate.promise;
  events.push('end:'+action.id);active--;
  return action.id;
 });
 const a=approve({id:'first'}),b=approve({id:'second'}),c=approve({id:'third'});
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(events,['start:first']);
 gate.resolve();
 assert.deepEqual(await Promise.all([a,b,c]),['first','second','third']);
 assert.deepEqual(events,['start:first','end:first','start:second','end:second','start:third','end:third']);
 assert.equal(maxActive,1);
});

test('a rejected approval does not poison the queue or grant the next request',async()=>{
 const seen=[];
 const approve=createSerializedLocalApproval(async action=>{
  seen.push(action.id);
  if(action.id==='deny')throw new Error('console unavailable');
  return action.id==='allow';
 });
 await assert.rejects(approve({id:'deny'}),/console unavailable/);
 assert.equal(await approve({id:'allow'}),true);
 assert.deepEqual(seen,['deny','allow']);
});

test('approval payload identity is passed through unmodified to the local authorizer',async()=>{
 const payload=Object.freeze({kind:'terminal_patch_apply',groupId:'group-A',sessionId:'session-A',sha256:'a'.repeat(64),files:Object.freeze(['src/index.js']),commit:false,push:false});
 let received;
 const approve=createSerializedLocalApproval(async action=>{received=action;return true;});
 assert.equal(await approve(payload),true);
 assert.equal(received,payload);
 assert.deepEqual(Object.keys(received),Object.keys(payload));
});
