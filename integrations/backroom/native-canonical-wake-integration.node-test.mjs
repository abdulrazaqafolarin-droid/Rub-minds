import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {TargetRegistry} from './target-registry.mjs';
import {BackroomDispatcher} from './dispatcher.mjs';
import {LocalExecutionGuard} from './host-runtime.mjs';
import {NativeCanonicalWakeAdapter} from './native-canonical-wake-adapter.mjs';
import {buildCanonicalWakePrompt} from './coordination-core.mjs';
import {dispatchClaimedWake} from './durable-wake-runtime.mjs';

const target = Object.freeze({
  id:'native-target-1', roomId:'room-1', hostId:'host-1', spaceId:'space-1',
  sessionId:'session-1', appId:'com.example.chat',
  identityFingerprint:'foreground-app-fingerprint',
  surface:'android_app', locatorKind:'accessibility',
  locatorValue:'native-composer-opaque', revision:3,
});
const eventId='message-001';
const prompt=buildCanonicalWakePrompt(eventId);
const sessionDigest='d'.repeat(64);
const binding=Object.freeze({
  bindingId:'binding-1',groupId:target.roomId,participantId:'ai-1',
  sessionId:target.sessionId,targetId:target.id,capabilities:['draft','wake'],
});
const participant=Object.freeze({
  groupId:target.roomId,participantId:'ai-1',sessionId:target.sessionId,status:'ready',
});
const lease=Object.freeze({
  jobId:'job-001',eventId,roomId:target.roomId,participantId:participant.participantId,
  hostId:target.hostId,sessionId:target.sessionId,bindingId:binding.bindingId,
  targetId:target.id,spaceId:target.spaceId,targetIdentityFingerprint:target.identityFingerprint,
  targetRevision:target.revision,prompt,promptDigest:createHash('sha256').update(prompt,'utf8').digest('hex'),
  leaseToken:'lease-001',sessionDigest,
});

function readyState(focused=true) {
  return {
    connected:true,focused,composerEmpty:true,composerIdentityVerified:true,
    sendControlUnique:true,sendControlEnabled:true,sendControlVisible:true,
    sendControlIdentityVerified:true,targetId:target.id,targetRevision:target.revision,
    locatorKind:'accessibility',composerIdentityDigest:'a'.repeat(64),
    sendControlIdentityDigest:'b'.repeat(64),surface:target.surface,
    appId:target.appId,sessionId:target.sessionId,identityFingerprint:target.identityFingerprint,
  };
}
function submitted(input, overrides={}) {
  return {
    state:'submitted',eventId:input.eventId,targetId:input.target.targetId,
    targetRevision:input.target.targetRevision,
    composerIdentityDigest:'a'.repeat(64),sendControlIdentityDigest:'b'.repeat(64),
    promptInserted:true,promptReadbackVerified:true,composerIdentityRevalidated:true,
    sendControlIdentityRevalidated:true,sendInvoked:true,composerCleared:true,
    ...overrides,
  };
}
function harness({focused=true,submitOverrides={},throwOnSubmit=false}={}) {
  const order=[],driverCalls=[];
  const registry=new TargetRegistry();registry.register(target);
  const adapter=new NativeCanonicalWakeAdapter({
    targetId:target.id,roomId:target.roomId,hostId:target.hostId,spaceId:target.spaceId,
    surface:target.surface,appId:target.appId,sessionId:target.sessionId,
    identityFingerprint:target.identityFingerprint,locatorValue:target.locatorValue,
    targetRevision:target.revision,
    driver:{
      async inspectWakeTarget(input){order.push('inspect');driverCalls.push(['inspect',input]);return readyState(focused);},
      async submitCanonicalWake(input){
        order.push('native-send');driverCalls.push(['send',input]);
        if(throwOnSubmit)throw new Error('native channel disconnected after uncertain UI action');
        return submitted(input,submitOverrides);
      },
    },
  });
  const guard=new LocalExecutionGuard({
    host:{hostId:target.hostId,deviceLabel:'trusted native companion',surfaces:[target.surface],operations:['wake']},
    adapter,isConnected:async()=>true,permission:async()=>{order.push('local-permission');return true;},
  });
  const dispatcher=new BackroomDispatcher({registry,adapter:guard,authorize:async()=>true});
  const store={
    async acknowledge(input){order.push('queue-ack');driverCalls.push(['ack',input]);return true;},
    async retry(input){order.push('queue-retry');driverCalls.push(['retry',input]);return 'pending';},
  };
  const seals=new Set(),consumed=new Set();
  const run=()=>dispatchClaimedWake({
    lease,store,dispatcher,approval:{grantId:'wake-grant-1'},
    verifyApproval:async()=>{order.push('verify-grant');return true;},
    consumeApproval:async(_approval,context)=>{
      order.push('consume-grant');
      if(consumed.has(context.eventId))return false;
      consumed.add(context.eventId);return true;
    },
    executionSeal:async command=>{
      order.push('reserve-seal');
      if(seals.has(command.id))return false;
      seals.add(command.id);return true;
    },
    hostId:target.hostId,sessionDigest,targetRegistry:registry,binding,participant,
    composerEmpty:true,foregroundSessionId:target.sessionId,
  });
  return {run,order,driverCalls,seals,consumed};
}

test('durable claimed wake reaches the native adapter only after grant verification, preflight and seal',async()=>{
  const f=harness();
  const result=await f.run();
  assert.equal(result.state,'completed');
  assert.equal(f.order.indexOf('verify-grant')<f.order.indexOf('inspect'),true);
  assert.equal(f.order.indexOf('local-permission')<f.order.indexOf('inspect'),true);
  assert.equal(f.order.indexOf('inspect')<f.order.indexOf('reserve-seal'),true);
  assert.equal(f.order.indexOf('reserve-seal')<f.order.indexOf('consume-grant'),true);
  assert.equal(f.order.indexOf('consume-grant')<f.order.indexOf('native-send'),true);
  assert.equal(f.driverCalls.filter(([kind])=>kind==='send').length,1);
  assert.equal(f.driverCalls.find(([kind])=>kind==='send')[1].prompt,prompt);
  assert.equal(f.driverCalls.find(([kind])=>kind==='ack')[1].outcome,'acknowledged');
});

test('native foreground/composer preflight failure retries before sealing or consuming the grant',async()=>{
  const f=harness({focused:false});
  const result=await f.run();
  assert.equal(result.state,'deferred');
  assert.equal(result.reason,'host-preflight-denied');
  assert.equal(f.seals.size,0);
  assert.equal(f.consumed.size,0);
  assert.equal(f.driverCalls.some(([kind])=>kind==='send'),false);
  assert.equal(f.driverCalls.some(([kind])=>kind==='retry'),true);
  assert.equal(f.driverCalls.some(([kind])=>kind==='ack'),false);
});

test('uncertain native Send is acknowledged as ignored and is never automatically replayed',async()=>{
  const f=harness({submitOverrides:{composerCleared:false}});
  const first=await f.run();
  assert.equal(first.state,'ignored');
  assert.equal(first.reason,'needs_review');
  const second=await f.run();
  assert.equal(second.state,'ignored');
  assert.equal(f.driverCalls.filter(([kind])=>kind==='send').length,1);
  assert.equal(f.driverCalls.filter(([kind])=>kind==='retry').length,0);
});

test('native channel loss after the execution seal never becomes a retry signal',async()=>{
  const f=harness({throwOnSubmit:true});
  const result=await f.run();
  assert.equal(result.state,'ignored');
  assert.equal(result.reason,'needs_review');
  assert.equal(f.seals.size,1);
  assert.equal(f.consumed.size,1);
  assert.equal(f.driverCalls.filter(([kind])=>kind==='send').length,1);
  assert.equal(f.driverCalls.filter(([kind])=>kind==='retry').length,0);
});
