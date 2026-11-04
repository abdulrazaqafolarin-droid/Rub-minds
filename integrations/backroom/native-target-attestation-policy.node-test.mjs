import test from 'node:test';
import assert from 'node:assert/strict';
import {validateNativeTargetAttestationRequest} from './native-target-attestation-policy.mjs';

const request={
 requestId:'50000000-0000-4000-8000-000000000001',
 screenSessionId:'50000000-0000-4000-8000-000000000002',
 roomId:'50000000-0000-4000-8000-000000000003',
 hostId:'50000000-0000-4000-8000-000000000004',
 participantId:'50000000-0000-4000-8000-000000000005',
 sessionDigest:'a'.repeat(64),spaceId:'android-device',targetSessionId:'target-session-1',
 targetId:'target-1',targetRevision:1,appPackageName:'com.example.provider',
 appSignerSha256:'b'.repeat(64),composerIdentityDigest:'c'.repeat(64),
 sendControlIdentityDigest:'d'.repeat(64),providerConversationIdentityDigest:'e'.repeat(64)
};

test('accepts exact device-attested request with opaque identity digests',()=>{
 const value=validateNativeTargetAttestationRequest(request);
 assert.ok(value);
 assert.equal(value.providerConversationIdentityDigest,'e'.repeat(64));
});

test('rejects missing, malformed and browser-injected extra fields',()=>{
 assert.equal(validateNativeTargetAttestationRequest({...request,providerConversationIdentityDigest:undefined}),null);
 assert.equal(validateNativeTargetAttestationRequest({...request,composerIdentityDigest:'raw-composer'}),null);
 assert.equal(validateNativeTargetAttestationRequest({...request,appSignerSha256:'raw-signer'}),null);
 assert.equal(validateNativeTargetAttestationRequest({...request,extra:'browser-supplied-digest'}),null);
});

test('rejects invalid session scope, target revision and package metadata',()=>{
 assert.equal(validateNativeTargetAttestationRequest({...request,screenSessionId:'bad'}),null);
 assert.equal(validateNativeTargetAttestationRequest({...request,targetRevision:0}),null);
 assert.equal(validateNativeTargetAttestationRequest({...request,targetId:'bad target'}),null);
 assert.equal(validateNativeTargetAttestationRequest({...request,appPackageName:'https://example.test'}),null);
 assert.equal(validateNativeTargetAttestationRequest({...request,targetSessionId:'bad\nvalue'}),null);
});
