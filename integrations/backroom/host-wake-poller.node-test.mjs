import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackroomWakePoller} from './host-wake-poller.mjs';
const hostId='40000000-0000-4000-8000-000000000011';
const bindingId='40000000-0000-4000-8000-000000000022';
const sessionDigest='a'.repeat(64);
const dispatcher={enqueue(){throw Error('not expected');},step(){throw Error('not expected');},status(){throw Error('not expected');}};
function runtime(){return {hostId,running:true,dispatcher,
 resolveClaimedWakeContext:()=>null,verifyClaimedWakeGrant:()=>false};}
test('poller is inert until explicit start and refuses host mismatch',async()=>{
 let claims=0;
 const store={claim:async()=>{claims++;return []},retry:async()=>null,acknowledge:async()=>false};
 const args={store,browserRuntime:runtime(),hostId,bindingId,sessionDigest,executionJournal:{reserve:async()=>true},intervalMs:1000};
 const poller=createBackroomWakePoller(args);
 assert.equal(poller.running,false);
 assert.deepEqual(await poller.pollOnce(),{state:'stopped'});
 assert.equal(claims,0);
 assert.throws(()=>createBackroomWakePoller({...args,hostId:bindingId}),/mismatch/);
 await poller.start();
 assert.equal(poller.running,true);
 await poller.stop();
 assert.equal(poller.running,false);
 assert.ok(claims<=1);
});
test('stopped browser cannot claim or dispatch',async()=>{
 let claims=0;
 const browserRuntime={...runtime(),running:false};
 const store={claim:async()=>{claims++;return []},retry:async()=>null,acknowledge:async()=>false};
 const poller=createBackroomWakePoller({store,browserRuntime,hostId,bindingId,sessionDigest,
 executionJournal:{reserve:async()=>true},intervalMs:1000});
 await poller.start();
 const result=await poller.pollOnce();
 assert.equal(result.state,'browser-stopped');
 await poller.stop();
 assert.equal(claims,0);
});
test('store errors fail closed without logging sensitive details',async()=>{
 const browserRuntime=runtime();
 const store={claim:async()=>{throw Error('Sensitive credential value')},retry:async()=>null,acknowledge:async()=>false};
 const poller=createBackroomWakePoller({store,browserRuntime,hostId,bindingId,sessionDigest,
 executionJournal:{reserve:async()=>true},intervalMs:1000});
 await poller.start();
 const result=await poller.pollOnce();
 assert.equal(result.state,'unavailable');
 assert.equal(JSON.stringify(result).includes('Sensitive'),false);
 await poller.stop();
});
