import test from 'node:test';
import assert from 'node:assert/strict';
import {validateHostEnrollment,validatePendingWakeBinding} from './host-enrollment-policy.mjs';
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
