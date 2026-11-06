import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyExistingBinding} from './binding-registration-policy.mjs';
const ownerId='20000000-0000-4000-8000-000000000099';
const input={
 roomId:'10000000-0000-0000-0000-000000000099',
 participantId:'30000000-0000-0000-0000-000000000099',
 hostId:'40000000-0000-0000-8000-000000000099',
 sessionDigest:'b'.repeat(64),spaceId:'space-1',sessionId:'session-1',
 targetId:'target-1',targetIdentityFingerprint:'fingerprint-1',
 targetRevision:1,surface:'browser_tab',locatorKind:'dom',
 locatorValue:'textarea#prompt',participationMode:'mentions',maxWakesPerMinute:6
};
const existing={
 id:'60000000-0000-4000-8000-000000000001',owner_id:ownerId,
 room_id:input.roomId,participant_id:input.participantId,host_id:input.hostId,
 session_digest:input.sessionDigest,space_id:input.spaceId,session_id:input.sessionId,
 target_id:input.targetId,target_identity_fingerprint:input.targetIdentityFingerprint,
 target_revision:input.targetRevision,surface:input.surface,locator_kind:input.locatorKind,
 locator_value:input.locatorValue,participation_mode:input.participationMode,
 max_wakes_per_minute:input.maxWakesPerMinute,wake_enabled:false
};
test('new target with no active binding proceeds to insert',()=>{
 assert.deepEqual(classifyExistingBinding({ownerId,input}),{action:'insert'});
});
test('exact same inactive binding is idempotently reused without enabling consent',()=>{
 assert.deepEqual(classifyExistingBinding({ownerId,input,existingSession:existing}),{
  action:'reuse',bindingId:existing.id,wakeEnabled:false,existing:true,requiresLocalConsent:true
 });
 assert.equal(existing.wake_enabled,false);
});
test('same binding with active consent requires explicit revoke before another grant',()=>{
 assert.equal(classifyExistingBinding({ownerId,input,existingSession:{...existing,wake_enabled:true}}).reason,
  'existing_binding_active_revoke_first');
});
test('changed input identity or target revision is never silently rebound',()=>{
 for(const changed of [
  {target_revision:2},
  {target_identity_fingerprint:'other-window'},
  {locator_value:'textarea#other'},
  {session_id:'another-session'},
  {owner_id:'20000000-0000-0000-0000-000000000098'}
 ]){
  const result=classifyExistingBinding({ownerId,input,existingSession:{...existing,...changed}});
  assert.equal(result.action,'conflict');
  assert.equal(result.reason,'existing_binding_requires_revoke');
  assert.equal(result.bindingId,existing.id);
 }
});
test('generic registration cannot read or rewrite the device-attested provider digest',()=>{
 const digest='d'.repeat(64);
 const nativeInput={...input,surface:'android_app',locatorKind:'accessibility'};
 const nativeExisting={...existing,surface:'android_app',locator_kind:'accessibility',provider_conversation_identity_digest:digest};
 assert.equal(classifyExistingBinding({ownerId,input:nativeInput,existingSession:nativeExisting}).action,'reuse');
 assert.equal(nativeExisting.provider_conversation_identity_digest,digest);
 const explicitDigest={...nativeInput,providerConversationIdentityDigest:'e'.repeat(64)};
 assert.equal(classifyExistingBinding({ownerId,input:explicitDigest,existingSession:nativeExisting}).action,'conflict');
 assert.equal(classifyExistingBinding({ownerId,input:explicitDigest,existingSession:nativeExisting}).reason,'existing_binding_requires_revoke');
});

test('active target occupied by another AI returns existing binding for explicit revocation',()=>{
 const other={...existing,participant_id:'30000000-0000-0000-0000-000000000098',
  session_digest:'c'.repeat(64),wake_enabled:false};
 const result=classifyExistingBinding({ownerId,input,existingTarget:other});
 assert.deepEqual(result,{action:'conflict',reason:'existing_binding_requires_revoke',
  bindingId:other.id,wakeEnabled:false,requiresHostRevoke:false});
});
test('inconsistent active session and active target reservations require host-level repair',()=>{
 const other={...existing,id:'60000000-0000-4000-8000-000000000002',target_id:'other-target'};
 const result=classifyExistingBinding({ownerId,input,existingSession:existing,existingTarget:other});
 assert.deepEqual(result,{action:'conflict',reason:'multiple_active_binding_conflict',
  requiresHostRevoke:true,bindingId:null});
});
test('invalid policy inputs fail closed',()=>{
 assert.throws(()=>classifyExistingBinding({input}),/owner/);
 assert.throws(()=>classifyExistingBinding({ownerId,input:null}),/binding/);
});

test('unknown consent state is treated as a conflict rather than inactive',()=>{
 const incomplete={...existing};delete incomplete.wake_enabled;
 const result=classifyExistingBinding({ownerId,input,existingSession:incomplete});
 assert.equal(result.action,'conflict');
 assert.equal(result.reason,'existing_binding_requires_revoke');
});
