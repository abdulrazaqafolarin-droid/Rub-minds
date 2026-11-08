import test from "node:test";
import assert from "node:assert/strict";
import {
  validateFrameAIBindingChallengeRequest,
  validateFrameAIBindingCompletion,
  validateFrameAIBindingRevoke,
} from "./frame-ai-binding-protocol.mjs";

const id=(n)=>"123e4567-e89b-42d3-a456-"+String(n).padStart(12,"0");
const deviceId=id(1),roomId=id(2),runtimeSessionId=id(3),participantId=id(4),requestId=id(5);
const base={deviceId,roomId,runtimeSessionId,participantId,surface:"android_app",appId:"com.example.ai",requestId,issuedAt:100_000};

test("owner challenge validator accepts exact fresh surface-specific requests",()=>{
  assert.equal(validateFrameAIBindingChallengeRequest(base,{now:100_000})?.participantId,participantId);
  assert.equal(validateFrameAIBindingChallengeRequest({...base,surface:"terminal",appId:id(6)},{now:100_000})?.surface,"terminal");
  assert.equal(validateFrameAIBindingChallengeRequest({...base,surface:"windows_app",appId:id(6)},{now:100_000})?.surface,"windows_app");
});

test("owner challenge validator rejects stale, malformed, and extra fields",()=>{
  assert.equal(validateFrameAIBindingChallengeRequest({...base,issuedAt:69_999},{now:100_000}),null);
  assert.equal(validateFrameAIBindingChallengeRequest({...base,deviceId:"bad"},{now:100_000}),null);
  assert.equal(validateFrameAIBindingChallengeRequest({...base,appId:"com..ai"},{now:100_000}),null);
  assert.equal(validateFrameAIBindingChallengeRequest({...base,extra:true},{now:100_000}),null);
});

test("device completion validator accepts exact one-use challenge evidence",()=>{
  const valid={challengeId:id(7),nonce:"a".repeat(64),runtimeSessionId,surface:"android_app",appId:"com.example.ai",
    appIdentityFingerprint:"b".repeat(64),runtimeIdentityDigest:"c".repeat(64)};
  assert.equal(validateFrameAIBindingCompletion(valid)?.challengeId,id(7));
  assert.equal(validateFrameAIBindingCompletion({...valid,composerIdentityDigest:"d".repeat(64),
    sendControlIdentityDigest:"e".repeat(64),providerConversationIdentityDigest:"f".repeat(64)})?.surface,"android_app");
});

test("device completion rejects invalid nonce, identity, provider evidence and terminal claims",()=>{
  const valid={challengeId:id(7),nonce:"a".repeat(64),runtimeSessionId,surface:"android_app",appId:"com.example.ai",
    appIdentityFingerprint:"b".repeat(64),runtimeIdentityDigest:"c".repeat(64)};
  assert.equal(validateFrameAIBindingCompletion({...valid,nonce:"bad"}),null);
  assert.equal(validateFrameAIBindingCompletion({...valid,appIdentityFingerprint:"bad"}),null);
  assert.equal(validateFrameAIBindingCompletion({...valid,providerConversationIdentityDigest:"d".repeat(64)}),null);
  assert.equal(validateFrameAIBindingCompletion({...valid,other:true}),null);
  assert.equal(validateFrameAIBindingCompletion({...valid,surface:"terminal",appId:id(6),
    composerIdentityDigest:"d".repeat(64)}),null);
});

test("owner revoke validator is exact and scoped",()=>{
  const value={bindingId:id(7),roomId,deviceId};
  assert.deepEqual(validateFrameAIBindingRevoke(value),value);
  assert.equal(validateFrameAIBindingRevoke({...value,extra:true}),null);
});
