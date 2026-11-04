const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX64=/^[a-f0-9]{64}$/;
const PACKAGE=/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SIGNERS=/^[a-f0-9]{64}(?:\.[a-f0-9]{64})*$/;
const exactKeys=(value,keys)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&
 Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
const label=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&
 !/[\u0000-\u001f\u007f-\u009f]/.test(value);

export function validateNativeTargetAttestationRequest(value){
 const keys=[
  'requestId','screenSessionId','roomId','hostId','participantId','sessionDigest',
  'spaceId','targetSessionId','targetId','targetRevision','appPackageName',
  'appSignerSha256','composerIdentityDigest','sendControlIdentityDigest',
  'providerConversationIdentityDigest'
 ];
 if(!exactKeys(value,keys)||!UUID.test(value.requestId??'')||
   !UUID.test(value.screenSessionId??'')||!UUID.test(value.roomId??'')||
   !UUID.test(value.hostId??'')||!UUID.test(value.participantId??'')||
   !HEX64.test(value.sessionDigest??'')||!ID.test(value.spaceId??'')||
   !label(value.targetSessionId,256)||!ID.test(value.targetId??'')||
   !Number.isSafeInteger(value.targetRevision)||value.targetRevision<1||value.targetRevision>2147483647||
   !PACKAGE.test(value.appPackageName??'')||value.appPackageName.length>255||
   !SIGNERS.test(value.appSignerSha256??'')||
   !HEX64.test(value.composerIdentityDigest??'')||
   !HEX64.test(value.sendControlIdentityDigest??'')||
   !HEX64.test(value.providerConversationIdentityDigest??''))return null;
 return Object.freeze({...value});
}
