import test from 'node:test';
import assert from 'node:assert/strict';
import {validateHostEnrollment,validatePendingWakeBinding,validateBindingStatusQuery} from './host-enrollment-policy.mjs';
const uuid='40000000-0000-4000-8000-000000000011';
const binding={
 roomId:uuid,participantId:uuid,hostId:uuid,sessionDigest:'a'.repeat(64),
 spaceId:'space-1',sessionId:'session-1',targetId:'target-1',
 targetIdentityFingerprint:'page-fingerprint',targetRevision:1,
 surface:'browser_tab',locatorKind:'dom',locatorValue:'textarea#prompt'
};
test('accepts digest-only host enrollment with bounded TTL and no raw credential',()=>{
 const valid=validateHostEnrollment({hostId:uuid,credentialDigest:'b'.repeat(64)});
 assert.equal(valid.ttlSeconds,86400);
 assert.equal(valid.credentialDigest,'b'.repeat(64));
 assert.equal(validateHostEnrollment({hostId:uuid,credentialDigest:'c'.repeat(64),ttlSeconds:604800}).ttlSeconds,604800);
 assert.throws(()=>validateHostEnrollment({hostId:uuid,hostToken:'b'.repeat(64),credentialDigest:'b'.repeat(64)}),/Unexpected/);
 assert.throws(()=>validateHostEnrollment({hostId:uuid,credentialDigest:'b'.repeat(64),ttlSeconds:604801}),/TTL/);
});
test('binding creation only accepts inactive registration fields and explicit scoped metadata',()=>{
 const v=validatePendingWakeBinding(binding);
 assert.equal(v.participationMode,'mentions');
 assert.equal(v.maxWakesPerMinute,6);
 assert.throws(()=>validatePendingWakeBinding({...binding,wakeEnabled:true}),/Unexpected/);
 assert.throws(()=>validatePendingWakeBinding({...binding,confirmedAt:'2026-10-29'}),/Unexpected/);
 assert.throws(()=>validatePendingWakeBinding({...binding,targetRevision:0}),/targetRevision/);
 assert.throws(()=>validatePendingWakeBinding({...binding,sessionDigest:'fake'}),/sessionDigest/);
 assert.throws(()=>validatePendingWakeBinding({...binding,locatorValue:'textarea\nsecret'}),/locatorValue/);
 assert.throws(()=>validatePendingWakeBinding({...binding,maxWakesPerMinute:7}),/wake rate/);
 assert.throws(()=>validatePendingWakeBinding({...binding,surface:'arbitrary'}),/surface/);
});

test('native composer bindings remain registerable for human-approved draft use; optional digest is validated',()=>{
 const native={...binding,surface:'android_app',locatorKind:'accessibility'};
 const draftBinding=validatePendingWakeBinding(native);
 assert.equal(draftBinding.surface,'android_app');
 assert.equal(draftBinding.providerConversationIdentityDigest,undefined);
 assert.throws(()=>validatePendingWakeBinding({...native,providerConversationIdentityDigest:'bad'}),/providerConversationIdentityDigest/);
 const wakeCapable=validatePendingWakeBinding({...native,providerConversationIdentityDigest:'c'.repeat(64)});
 assert.equal(wakeCapable.providerConversationIdentityDigest,'c'.repeat(64));
});

test('binding status queries require owner-scoped room and optional participant identities',()=>{
 assert.deepEqual(validateBindingStatusQuery({roomId:uuid}),{roomId:uuid});
 assert.deepEqual(validateBindingStatusQuery({roomId:uuid,participantId:uuid,sessionDigest:'a'.repeat(64)}),
  {roomId:uuid,participantId:uuid,sessionDigest:'a'.repeat(64)});
 assert.throws(()=>validateBindingStatusQuery({roomId:uuid,ownerId:uuid}),/Unexpected/);
 assert.throws(()=>validateBindingStatusQuery({roomId:'not-a-uuid'}),/roomId/);
 assert.throws(()=>validateBindingStatusQuery({roomId:uuid,participantId:uuid}),/supplied together/);
 assert.throws(()=>validateBindingStatusQuery({roomId:uuid,sessionDigest:'a'.repeat(64)}),/supplied together/);
 assert.throws(()=>validateBindingStatusQuery({roomId:uuid,participantId:uuid,sessionDigest:'bad'}),/sessionDigest/);
});
