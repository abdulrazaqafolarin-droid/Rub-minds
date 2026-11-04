import test from 'node:test';
import assert from 'node:assert/strict';
import {
 validateNativeBindingIntentRequest,
 validateAndroidNativeBindingAttestation,
} from './native-binding-attestation-policy.mjs';

const ids={
 roomId:'10000000-0000-4000-8000-000000000001',
 participantId:'20000000-0000-4000-8000-000000000001',
 hostId:'30000000-0000-4000-8000-000000000001',
 deviceId:'40000000-0000-4000-8000-000000000001',
 screenSessionId:'50000000-0000-4000-8000-000000000001',
};
const intent={
 ...ids,sessionDigest:'a'.repeat(64),appPackageName:'com.example.chat',
};
const attestation={
 intentId:'60000000-0000-4000-8000-000000000001',
 screenSessionId:ids.screenSessionId,appPackageName:'com.example.chat',
 signingCertificateSha256:'b'.repeat(64),composerTargetId:'c'.repeat(64),
 sendControlTargetId:'d'.repeat(64),providerConversationIdentityDigest:'e'.repeat(64),
};

test('owner intent accepts only an exact scoped AI, host, device, screen session and selected app',()=>{
 assert.deepEqual(validateNativeBindingIntentRequest(intent),intent);
 for(const bad of [
  {...intent,ownerId:ids.hostId},
  {...intent,sessionDigest:'bad'},
  {...intent,deviceId:'not-a-uuid'},
  {...intent,screenSessionId:'not-a-uuid'},
  {...intent,appPackageName:'not a package'},
 ]) assert.equal(validateNativeBindingIntentRequest(bad),null);
});
test('device attestation is bound to the expected active screen and selected app signer',()=>{
 const accepted=validateAndroidNativeBindingAttestation(attestation,{
  screenSessionId:ids.screenSessionId,appPackageName:'com.example.chat',
  signingCertificateSha256:'b'.repeat(64),
 });
 assert.deepEqual(accepted,attestation);
 assert.equal(validateAndroidNativeBindingAttestation({...attestation,screenSessionId:ids.hostId},{
  screenSessionId:ids.screenSessionId,appPackageName:'com.example.chat',
  signingCertificateSha256:'b'.repeat(64),
 }),null);
 assert.equal(validateAndroidNativeBindingAttestation({...attestation,signingCertificateSha256:'f'.repeat(64)},{
  screenSessionId:ids.screenSessionId,appPackageName:'com.example.chat',
  signingCertificateSha256:'b'.repeat(64),
 }),null);
});
test('raw provider identifiers, missing digests, malformed targets and extra browser fields are rejected',()=>{
 for(const bad of [
  {...attestation,providerConversationIdentityDigest:undefined},
  {...attestation,providerConversationIdentityDigest:'raw-chat-id'},
  {...attestation,composerTargetId:'bad'},
  {...attestation,sendControlTargetId:'bad'},
  {...attestation,conversationId:'raw-provider-conversation-id'},
 ]) assert.equal(validateAndroidNativeBindingAttestation(bad,{
  screenSessionId:ids.screenSessionId,appPackageName:'com.example.chat',
  signingCertificateSha256:'b'.repeat(64),
 }),null);
});
