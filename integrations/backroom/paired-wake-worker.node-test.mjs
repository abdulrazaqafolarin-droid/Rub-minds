import test from 'node:test';
import assert from 'node:assert/strict';
import {pollPairedWakeJobs} from './paired-wake-worker.mjs';

const hostId='40000000-0000-4000-8000-000000000099';
const bindingId='40000000-0000-4000-8000-000000000088';
const sessionDigest='a'.repeat(64);
const dispatcher={enqueue(){throw new Error('unexpected dispatch');},step(){throw new Error('unexpected dispatch');},status(){return {state:'idle'};}};
function fixture(leases) {
  const calls=[];
  const store={
    async claim(args){calls.push(['claim',args]);return leases;},
    async retry(args){calls.push(['retry',args]);return 'pending';},
    async acknowledge(args){calls.push(['ack',args]);return true;}
  };
  return {store,calls};
}
test('empty poll performs one scoped claim without dispatch',async()=>{
  const {store,calls}=fixture([]);
  const result=await pollPairedWakeJobs({store,hostId,bindingId,sessionDigest,dispatcher,executionJournal:{reserve:async()=>true},
    resolveContext:()=>{throw new Error('not called');},verifyApproval:()=>false});
  assert.deepEqual(result,[]);
  assert.deepEqual(calls,[['claim',{hostId,sessionDigest,bindingId,limit:5}]]);
});
test('wrong host / binding / digest cannot be dispatched or acknowledged',async()=>{
  const {store,calls}=fixture([
    {jobId:'one',hostId:'another-host',sessionDigest,bindingId},
    {jobId:'two',hostId,sessionDigest,bindingId:'wrong-binding'},
    {jobId:'three',hostId,sessionDigest:'bad-digest',bindingId}
  ]);
  let resolverCalls=0;
  const result=await pollPairedWakeJobs({store,hostId,bindingId,sessionDigest,dispatcher,executionJournal:{reserve:async()=>true},
    resolveContext:()=>{resolverCalls++;return null;},verifyApproval:()=>false});
  assert.equal(result.length,3);
  assert.ok(result.every(row=>row.state==='rejected'&&row.reason==='claim-scope-mismatch'));
  assert.equal(resolverCalls,0);
  assert.equal(calls.length,1);
});
test('rejects oversized batches before any dispatcher effect',async()=>{
  const {store,calls}=fixture([{},{}]);
  await assert.rejects(()=>pollPairedWakeJobs({store,hostId,bindingId,sessionDigest,limit:1,dispatcher,executionJournal:{reserve:async()=>true},
    resolveContext:()=>null,verifyApproval:()=>false}),/Invalid lease batch/);
  assert.equal(calls.length,1);
});
test('requires a trusted binding resolver, verifier and valid limit',async()=>{
  const {store}=fixture([]);
  await assert.rejects(()=>pollPairedWakeJobs({store,hostId,bindingId,sessionDigest,dispatcher,verifyApproval:()=>false}),/resolver/);
  await assert.rejects(()=>pollPairedWakeJobs({store,hostId,bindingId,sessionDigest,dispatcher,executionJournal:{reserve:async()=>true},resolveContext:()=>null}),/verifier/);
  await assert.rejects(()=>pollPairedWakeJobs({store,hostId,bindingId,sessionDigest,dispatcher,executionJournal:{reserve:async()=>true},resolveContext:()=>null,verifyApproval:()=>false,limit:21}),/limit/);
});
