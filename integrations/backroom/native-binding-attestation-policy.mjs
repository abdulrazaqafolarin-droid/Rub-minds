const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX64=/^[a-f0-9]{64}$/;
const PACKAGE=/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const CERTS=/^[0-9a-f]{64}(?:\.[0-9a-f]{64})*$/;
function exactKeys(value,keys){
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
}
export function validateNativeBindingIntentRequest(value){
 const keys=['roomId','participantId','sessionDigest','hostId','deviceId','screenSessionId','appPackageName'];
 if(!exactKeys(value,keys)||!UUID.test(value.roomId??'')||!UUID.test(value.participantId??'')||
  !UUID.test(value.hostId??'')||!UUID.test(value.deviceId??'')||
  !UUID.test(value.screenSessionId??'')||!HEX64.test(value.sessionDigest??'')||
  !PACKAGE.test(value.appPackageName??''))return null;
 return Object.freeze({...value});
}
export function validateAndroidNativeBindingAttestation(value,expected){
 const keys=['intentId','screenSessionId','appPackageName','signingCertificateSha256',
  'composerTargetId','sendControlTargetId','providerConversationIdentityDigest'];
 if(!exactKeys(value,keys)||!expected||!UUID.test(value.intentId??'')||
  !UUID.test(value.screenSessionId??'')||value.screenSessionId!==expected.screenSessionId||
  value.appPackageName!==expected.appPackageName||!PACKAGE.test(value.appPackageName??'')||
  !CERTS.test(value.signingCertificateSha256??'')||
  value.signingCertificateSha256!==expected.signingCertificateSha256||
  !HEX64.test(value.composerTargetId??'')||!HEX64.test(value.sendControlTargetId??'')||
  !HEX64.test(value.providerConversationIdentityDigest??''))return null;
 return Object.freeze({...value});
}
