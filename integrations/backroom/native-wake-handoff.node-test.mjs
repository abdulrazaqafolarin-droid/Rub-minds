import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
 createNativeWakeHandoff,validateNativeWakeHandoff,
 createNativeWakeHandoffResult,validateNativeWakeHandoffResult,
 NativeWakeHandoffReceiver,
} from './native-wake-handoff.mjs';
import {buildCanonicalWakePrompt} from './coordination-core.mjs';

const ids={
 jobId:'70000000-0000-4000-8000-000000000001',
 leaseToken:'71000000-0000-4000-8000-000000000001',
 deviceId:'72000000-0000-4000-8000-000000000001',
 roomId:'73000000-0000-4000-8000-000000000001',
 screenSessionId:'74000000-0000-4000-8000-000000000001',
 bindingId:'75000000-0000-4000-8000-000000000001',
 hostId:'76000000-0000-4000-8000-000000000001',
};
const now=100_000;
const prompt=buildCanonicalWakePrompt('event_123');
const digest=createHash('sha256').update(prompt,'utf8').digest('hex');
const lease={
 ...ids,eventId:'event_123',sessionId:'mcp-session-1',targetId:'native-target-1',
 targetIdentityFingerprint:'fingerprint-1',targetRevision:4,prompt,promptDigest:digest,
 expiresAt:now+60_000,
};
const scope={
 deviceId:ids.deviceId,roomId:ids.roomId,screenSessionId:ids.screenSessionId,
 bindingId:ids.bindingId,hostId:ids.hostId,sessionId:lease.sessionId,
 targetId:lease.targetId,targetRevision:lease.targetRevision,surface:'android_app',
 appId:'com.example.chat',identityFingerprint:lease.targetIdentityFingerprint,
 composerIdentityDigest:'a'.repeat(64),sendControlIdentityDigest:'b'.repeat(64),
};
const digestPrompt=value=>createHash('sha256').update(value,'utf8').digest('hex');
const create=(overrides={},options={})=>createNativeWakeHandoff(
 {...lease,...overrides},scope,{now,...options}
);
function submitted(){return {
 state:'submitted',promptInserted:true,promptReadbackVerified:true,
 composerIdentityRevalidated:true,sendControlIdentityRevalidated:true,
 composerIdentityDigest:scope.composerIdentityDigest,
 sendControlIdentityDigest:scope.sendControlIdentityDigest,
 sendInvoked:true,composerCleared:true,
};}
function receiver(){
 return new NativeWakeHandoffReceiver({scope,now:()=>now});
}

test('creates an immutable short-lived handoff containing only a canonical event trigger',()=>{
 const handoff=create();
 assert.equal(handoff.kind,'native_wake_trigger');
 assert.equal(handoff.version,1);
 assert.equal(handoff.prompt,prompt);
 assert.equal(handoff.promptDigest,digestPrompt(prompt));
 assert.equal(handoff.leaseTokenDigest,digestPrompt(lease.leaseToken));
 assert.equal('leaseToken' in handoff,false);
 assert.equal(handoff.expiresAt,now+20_000);
 assert.equal(Object.isFrozen(handoff),true);
 assert.equal('messageBody' in handoff,false);
 assert.equal('responseBody' in handoff,false);
 assert.deepEqual(validateNativeWakeHandoff(handoff,scope,{now}),handoff);
});

test('handoff expiry never exceeds the original durable lease expiry',()=>{
 const handoff=create({expiresAt:now+5_000});
 assert.equal(handoff.expiresAt,now+5_000);
 assert.throws(()=>create({expiresAt:now+100}),/close to expiry/);
});

test('rejects a target/room/device/session/binding scope mismatch before handoff creation',()=>{
 assert.throws(()=>create({}, {now, handoffId:'invalid'}),/identity or clock/);
 for(const mutate of [
  s=>s.deviceId='72000000-0000-4000-8000-000000000099',
  s=>s.roomId='73000000-0000-4000-8000-000000000099',
  s=>s.screenSessionId='74000000-0000-4000-8000-000000000099',
  s=>s.bindingId='75000000-0000-4000-8000-000000000099',
  s=>s.targetRevision+=1,
  s=>s.identityFingerprint='replacement',
 ]){const s={...scope};mutate(s);assert.throws(()=>createNativeWakeHandoff(lease,s,{now}),/scope mismatch/);}
});

test('rejects message text, wrong event prompt and prompt-digest tampering',()=>{
 assert.throws(()=>create({...lease,messageBody:'private group message'}),/valid canonical durable wake lease/);
 assert.throws(()=>create({prompt:'hello'}),/valid canonical durable wake lease/);
 const h=create();
 assert.equal(validateNativeWakeHandoff({...h,prompt:'hello'},scope,{now}),null);
 assert.equal(validateNativeWakeHandoff({...h,promptDigest:'0'.repeat(64)},scope,{now}),null);
 assert.equal(validateNativeWakeHandoff({...h,messageBody:'private text'},scope,{now}),null);
 assert.equal(validateNativeWakeHandoff({...h,leaseToken:lease.leaseToken},scope,{now}),null);
 assert.equal(validateNativeWakeHandoff({...h,leaseTokenDigest:'bad'},scope,{now}),null);
});

test('rejects unsupported surface, stale/future handoffs and lease-expiry extension',()=>{
 const h=create();
 assert.equal(validateNativeWakeHandoff({...h,surface:'browser_tab'},scope,{now}),null);
 assert.equal(validateNativeWakeHandoff(h,scope,{now:h.expiresAt}),null);
 assert.equal(validateNativeWakeHandoff({...h,issuedAt:now+5_000},scope,{now}),null);
 assert.equal(validateNativeWakeHandoff({...h,expiresAt:h.leaseExpiresAt+1},scope,{now}),null);
 assert.equal(validateNativeWakeHandoff({...h,expiresAt:now+20_001},scope,{now}),null);
});

test('receiver accepts the exact device/session handoff once and rejects replay',()=>{
 const r=receiver(),h=create();
 assert.deepEqual(r.accept(h),h);
 assert.equal(r.accept(h),null);
 assert.equal(r.status(h.jobId).active,true);
});

test('preflight denial is a safe retry only when no prompt was inserted and Send was not invoked',()=>{
 const r=receiver(),h=create();
 assert.ok(r.accept(h));
 const ack=r.settle(h.handoffId,{
  state:'preflight_denied',promptInserted:false,sendInvoked:false,
  composerCleared:false,reason:'foreground_changed',
 });
 assert.equal(ack.state,'preflight_denied');
 assert.equal(r.status(h.jobId).active,false);
 assert.equal(r.status(h.jobId).terminal,false);
 assert.equal(r.accept(h),null);
 const next=create({leaseToken:'71000000-0000-4000-8000-000000000002'},{handoffId:'77000000-0000-4000-8000-000000000001'});
 assert.ok(r.accept(next));
});

test('preflight denial cannot claim Send or prompt insertion happened',()=>{
 const r=receiver(),h=create();r.accept(h);
 assert.equal(r.settle(h.handoffId,{
  state:'preflight_denied',promptInserted:true,sendInvoked:false,
  composerCleared:false,reason:'foreground_changed',
 }),null);
 assert.equal(r.status(h.jobId).active,true);
});

test('submitted result requires prompt readback, unchanged identities, Send and composer clear',()=>{
 const h=create();
 const good=createNativeWakeHandoffResult(h,submitted());
 assert.equal(validateNativeWakeHandoffResult(good,h),true);
 for(const override of [
  {composerCleared:false},{sendInvoked:false},{promptInserted:false},
  {promptReadbackVerified:false},{composerIdentityRevalidated:false},
  {sendControlIdentityRevalidated:false},
 ])assert.throws(()=>createNativeWakeHandoffResult(h,{...submitted(),...override}),/Invalid/);
 const r=receiver();r.accept(h);
 const ack=r.settle(h.handoffId,submitted());
 assert.equal(ack.state,'submitted');
 assert.equal(validateNativeWakeHandoffResult(ack,h),true);
 assert.equal(r.status(h.jobId).terminal,true);
 assert.equal(r.accept(create({leaseToken:'71000000-0000-4000-8000-000000000002'},{handoffId:'77000000-0000-4000-8000-000000000002'})),null);
});

test('uncertain outcomes are terminal and never permit an automatic second handoff',()=>{
 const r=receiver(),h=create();r.accept(h);
 const ack=r.settle(h.handoffId,{
  state:'needs_review',promptInserted:true,sendInvoked:true,
  composerCleared:false,reason:'send_unconfirmed',
 });
 assert.equal(ack.state,'needs_review');
 assert.equal(r.status(h.jobId).terminal,true);
 assert.equal(r.accept(create({leaseToken:'71000000-0000-4000-8000-000000000002'},{handoffId:'77000000-0000-4000-8000-000000000003'})),null);
});

test('result envelopes cannot cross devices, jobs, screen sessions or targets',()=>{
 const h=create();
 const ack=createNativeWakeHandoffResult(h,submitted());
 assert.equal(validateNativeWakeHandoffResult({...ack,deviceId:'72000000-0000-4000-8000-000000000099'},h),false);
 assert.equal(validateNativeWakeHandoffResult({...ack,jobId:'70000000-0000-4000-8000-000000000099'},h),false);
 assert.equal(validateNativeWakeHandoffResult({...ack,screenSessionId:'74000000-0000-4000-8000-000000000099'},h),false);
 assert.equal(validateNativeWakeHandoffResult({...ack,targetRevision:99},h),false);
});

test('receiver bounds state and rejects after its replay ledger is full',()=>{
 const r=new NativeWakeHandoffReceiver({scope,now:()=>now,maxJobs:1,maxHandoffs:1});
 assert.ok(r.accept(create()));
 const other={...lease,jobId:'70000000-0000-4000-8000-000000000002',eventId:'event_456',
  prompt:buildCanonicalWakePrompt('event_456')};
 other.promptDigest=digestPrompt(other.prompt);
 other.leaseToken='71000000-0000-4000-8000-000000000002';
 assert.equal(r.accept(createNativeWakeHandoff(other,scope,{now,handoffId:'77000000-0000-4000-8000-000000000004'})),null);
});
