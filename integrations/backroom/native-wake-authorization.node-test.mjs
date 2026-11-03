import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NativeWakeAuthorizationAuthority,
  reserveNativeWakeExecution,
} from './native-wake-authorization.mjs';
import {buildCanonicalWakePrompt} from './coordination-core.mjs';

const ids = {
  hostId:'10000000-0000-4000-8000-000000000001',
  groupId:'20000000-0000-4000-8000-000000000001',
  participantId:'30000000-0000-4000-8000-000000000001',
  sessionId:'40000000-0000-4000-8000-000000000001',
  bindingId:'50000000-0000-4000-8000-000000000001',
  targetId:'60000000-0000-4000-8000-000000000001',
  spaceId:'android:phone-1',
  surface:'android_app',
  appId:'com.example.chat',
  identityFingerprint:'foreground-app-fingerprint',
  targetRevision:2,
};
const target = Object.freeze({
  id:ids.targetId,roomId:ids.groupId,hostId:ids.hostId,spaceId:ids.spaceId,
  sessionId:ids.sessionId,appId:ids.appId,surface:ids.surface,
  identityFingerprint:ids.identityFingerprint,providerConversationIdentityDigest:ids.providerConversationIdentityDigest,
  locatorKind:'accessibility',
  locatorValue:'opaque-composer-handle',revision:ids.targetRevision,
});
function command(overrides={}) {
  return {
    id:'wake_70000000000040008000000000000001',eventId:'event_1',
    operation:'wake',text:buildCanonicalWakePrompt('event_1'),
    hostId:ids.hostId,roomId:ids.groupId,participantId:ids.participantId,
    sessionId:ids.sessionId,spaceId:ids.spaceId,bindingId:ids.bindingId,
    targetId:ids.targetId,targetRevision:ids.targetRevision,
    identityFingerprint:ids.identityFingerprint,
    providerConversationIdentityDigest:ids.providerConversationIdentityDigest,
    ...overrides,
  };
}
function fixture({now=1000,maxPerMinute=2,ttlMs=120000}={}) {
  const clock={value:now};
  const authority=new NativeWakeAuthorizationAuthority({
    now:()=>clock.value,maxPerMinute,maxGrantMs:MAX_MAX_GRANT,
  });
  const grant=authority.createGrant({
    ...ids,localConfirmation:true,ttlMs,maxPerMinute,
  });
  return {authority,grant,clock};
}
const MAX_MAX_GRANT=24*60*60*1000;

test('native wake requires explicit local confirmation and a native accessibility target',()=>{
  const authority=new NativeWakeAuthorizationAuthority();
  assert.throws(()=>authority.createGrant({...ids,localConfirmation:false}),/on-device confirmation/);
  assert.throws(()=>authority.createGrant({...ids,surface:'browser_tab',localConfirmation:true}),/surface or revision/);
  assert.throws(()=>authority.createGrant({...ids,localConfirmation:true,targetRevision:0}),/surface or revision/);
});

test('grant is scoped to one host, group, AI session, app and target revision',()=>{
  const f=fixture();
  assert.equal(f.authority.verify(f.grant.grantId,{command:command(),target}),true);
  assert.equal(f.authority.verify(f.grant.grantId,{command:command({roomId:'other'}),target}),false);
  assert.equal(f.authority.verify(f.grant.grantId,{command:command({sessionId:'other'}),target}),false);
  assert.equal(f.authority.verify(f.grant.grantId,{command:command({bindingId:'other'}),target}),false);
  assert.equal(f.authority.verify(f.grant.grantId,{command:command({targetRevision:3}),target}),false);
  assert.equal(f.authority.verify(f.grant.grantId,{command:command(),target:{...target,appId:'other'}}),false);
  assert.equal(f.authority.verify(f.grant.grantId,{command:command(),target:{...target,revision:3}}),false);
  assert.equal(f.authority.verify(f.grant.grantId,{command:command(),target:{...target,providerConversationIdentityDigest:'f'.repeat(64)}}),false);
  assert.equal(f.authority.verify(f.grant.grantId,{command:command({providerConversationIdentityDigest:'f'.repeat(64)}),target}),false);
});

test('only exact canonical event-bound wake prompt is authorized',()=>{
  const f=fixture();
  assert.equal(f.authority.verify(f.grant.grantId,{command:command({text:'hello'}),target}),false);
  assert.equal(f.authority.verify(f.grant.grantId,{
    command:command({text:buildCanonicalWakePrompt('event_other')}),target,
  }),false);
  assert.equal(f.authority.verify(f.grant.grantId,{command:command({operation:'draft'}),target}),false);
});

test('preflight verification does not consume; exact event command is consumed once',()=>{
  const f=fixture(),c=command();
  assert.equal(f.authority.verify(f.grant.grantId,{command:c,target}),true);
  assert.equal(f.authority.verify(f.grant.grantId,{command:c,target},{consume:false}),true);
  assert.equal(f.authority.status(f.grant.grantId).usedCommands,0);
  assert.equal(f.authority.verify(f.grant.grantId,{command:c,target},{consume:true}),true);
  assert.equal(f.authority.status(f.grant.grantId).usedCommands,1);
  assert.equal(f.authority.verify(f.grant.grantId,{command:c,target}),false);
});

test('grant enforces its own per-minute rate limit',()=>{
  const f=fixture({maxPerMinute:1});
  assert.equal(f.authority.verify(f.grant.grantId,{command:command(),target},{consume:true}),true);
  assert.equal(f.authority.verify(f.grant.grantId,{command:command({id:'wake_80000000000040008000000000000001',eventId:'event_2',text:buildCanonicalWakePrompt('event_2')}),target},{consume:true}),false);
  f.clock.value+=60_001;
  assert.equal(f.authority.verify(f.grant.grantId,{command:command({id:'wake_80000000000040008000000000000001',eventId:'event_2',text:buildCanonicalWakePrompt('event_2')}),target},{consume:true}),true);
});

test('grant expiry, explicit revoke and process-local revoke-all are authoritative',()=>{
  const f=fixture({ttlMs:60_000});
  f.clock.value+=60_000;
  assert.equal(f.authority.verify(f.grant.grantId,{command:command(),target}),false);
  assert.equal(f.authority.status(f.grant.grantId).active,false);
  const next=fixture();
  assert.equal(next.authority.revoke(next.grant.grantId),true);
  assert.equal(next.authority.verify(next.grant.grantId,{command:command(),target}),false);
  const last=fixture();
  assert.equal(last.authority.revokeAll(),1);
  assert.equal(last.authority.status(last.grant.grantId).active,false);
});

test('target revision change requires a newly confirmed native grant',()=>{
  const f=fixture();
  assert.equal(f.authority.verify(f.grant.grantId,{
    command:command({targetRevision:ids.targetRevision+1}),
    target:{...target,revision:ids.targetRevision+1},
  }),false);
  const newAuthority=new NativeWakeAuthorizationAuthority();
  const rebound=newAuthority.createGrant({
    ...ids,localConfirmation:true,targetRevision:ids.targetRevision+1,
  });
  assert.equal(newAuthority.verify(rebound.grantId,{
    command:command({targetRevision:ids.targetRevision+1}),
    target:{...target,revision:ids.targetRevision+1},
  }),true);
});

test('durable journal reservation happens before one-shot local native grant consumption',async()=>{
  const f=fixture();
  const calls=[];
  const journal={
    async reserve(record){calls.push(['seal',record]);return true;},
  };
  const journalRecord={
    jobKey:'a'.repeat(64),
    jobId:'70000000-0000-4000-8000-000000000001',
    hostId:ids.hostId,bindingId:ids.bindingId,
    sessionDigest:'b'.repeat(64),targetId:ids.targetId,
  };
  const c=command();
  c.id='wake_'+journalRecord.jobId.replaceAll('-','');
  const reserved=await reserveNativeWakeExecution({
    authority:f.authority,grantId:f.grant.grantId,journal,journalRecord,command:c,target,
  });
  calls.push(['grant-used',f.authority.status(f.grant.grantId).usedCommands]);
  assert.equal(reserved,true);
  assert.equal(calls[0][0],'seal');
  assert.deepEqual(calls[1],['grant-used',1]);
});

test('duplicate persistent seal blocks native grant consumption',async()=>{
  const f=fixture(),c=command();
  const journalRecord={
    jobKey:'c'.repeat(64),jobId:'70000000-0000-4000-8000-000000000001',
    hostId:ids.hostId,bindingId:ids.bindingId,sessionDigest:'d'.repeat(64),targetId:ids.targetId,
  };
  let consumes=0;
  const original=f.authority.verify.bind(f.authority);
  f.authority.verify=(...args)=>{if(args[2]?.consume===true)consumes++;return original(...args);};
  const result=await reserveNativeWakeExecution({
    authority:f.authority,grantId:f.grant.grantId,
    journal:{reserve:async()=>false},journalRecord,command:c,target,
  });
  assert.equal(result,false);
  assert.equal(consumes,0);
});

test('invalid journal scope or mismatched command never reaches the journal',async()=>{
  const f=fixture();let calls=0;
  const journal={reserve:async()=>{calls++;return true;}};
  await assert.rejects(reserveNativeWakeExecution({
    authority:f.authority,grantId:f.grant.grantId,journal,
    journalRecord:{jobKey:'bad',jobId:'bad',hostId:'bad',bindingId:'bad',sessionDigest:'bad',targetId:'bad'},
    command:command(),target,
  }),/journal scope/);
  await assert.rejects(reserveNativeWakeExecution({
    authority:f.authority,grantId:f.grant.grantId,journal,
    journalRecord:{jobKey:'a'.repeat(64),jobId:'70000000-0000-4000-8000-000000000001',
      hostId:ids.hostId,bindingId:ids.bindingId,sessionDigest:'b'.repeat(64),targetId:ids.targetId},
    command:command({targetId:'other'}),target,
  }),/journal scope/);
  assert.equal(calls,0);
});


test('native grant refuses an absent or unverified provider conversation digest', () => {
  const authority = new NativeWakeAuthorizationAuthority();
  const { providerConversationIdentityDigest: _missing, ...unscoped } = ids;
  assert.throws(() => authority.createGrant({ ...unscoped, localConfirmation: true }), /surface or revision/);
  const f = fixture();
  assert.equal(f.authority.verify(f.grant.grantId, {
    command: command({ providerConversationIdentityDigest: undefined }), target,
  }), false);
});
