import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAndroidNativeTargetRegistration} from './android-streaming-protocol.mjs';

const ids={
 roomId:'10000000-0000-4000-8000-000000000001',
 requestId:'20000000-0000-4000-8000-000000000001',
 screenSessionId:'30000000-0000-4000-8000-000000000001'
};
const valid={
 ...ids,issuedAt:100_000,appPackageName:'com.openai.chatgpt',
 appSignerSha256:'a'.repeat(64),composerIdentityDigest:'b'.repeat(64),
 sendControlIdentityDigest:'c'.repeat(64),providerConversationIdentityDigest:'d'.repeat(64)
};

test('accepts only a fresh, exact device-attested native target registration',()=>{
 const result=validateAndroidNativeTargetRegistration(valid,{now:100_000});
 assert.equal(result.roomId,ids.roomId);
 assert.equal(result.providerConversationIdentityDigest,'d'.repeat(64));
 assert.equal(Object.isFrozen(result),true);
});
test('rejects malformed or missing target and provider identities',()=>{
 for(const patch of [
  {roomId:'not-a-uuid'},{requestId:'not-a-uuid'},{screenSessionId:'not-a-uuid'},
  {appPackageName:'ChatGPT'},{appSignerSha256:'x'.repeat(64)},
  {composerIdentityDigest:'x'.repeat(64)},{sendControlIdentityDigest:'x'.repeat(64)},
  {providerConversationIdentityDigest:'x'.repeat(64)},{providerConversationIdentityDigest:undefined}
 ]) assert.equal(validateAndroidNativeTargetRegistration({...valid,...patch},{now:100_000}),null);
});
test('rejects unexpected fields and stale or future registration timestamps',()=>{
 assert.equal(validateAndroidNativeTargetRegistration({...valid,rawConversationId:'must-not-leave-phone'},{now:100_000}),null);
 assert.equal(validateAndroidNativeTargetRegistration(valid,{now:140_001}),null);
 assert.equal(validateAndroidNativeTargetRegistration({...valid,issuedAt:104_000},{now:100_000}),null);
});
