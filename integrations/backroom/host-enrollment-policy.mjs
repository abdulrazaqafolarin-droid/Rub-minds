/**
 * Server-side enrollment validation for user-authorized Backroom host records.
 * User identity must come from a verified Supabase Auth JWT, never JSON input.
 */
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX64=/^[0-9a-f]{64}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SURFACES=new Set(['browser_tab','desktop_app','windows_app','terminal','android_app']);
const LOCATORS=new Set(['dom','accessibility','terminal_pty','screen_region']);
const MODES=new Set(['mentions','smart','task']);
function object(value){if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('Expected object');return value;}
function keys(value,permitted){if(Object.keys(value).some(key=>!permitted.includes(key)))throw new TypeError('Unexpected registration field');}
function label(value,name,max=256){
 if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f\u007f]/.test(value))throw new TypeError('Invalid '+name);
 return value;
}
function uuid(value,name){if(typeof value!=='string'||!UUID.test(value))throw new TypeError('Invalid '+name);return value;}
export function validateBindingStatusQuery(raw){
 const v=object(raw);
 keys(v,['roomId','participantId','sessionDigest']);
 const result={roomId:uuid(v.roomId,'roomId')};
 if((v.participantId===undefined)!==(v.sessionDigest===undefined))
  throw new TypeError('participantId and sessionDigest must be supplied together');
 if(v.participantId!==undefined){
  result.participantId=uuid(v.participantId,'participantId');
  if(typeof v.sessionDigest!=='string'||!HEX64.test(v.sessionDigest))
   throw new TypeError('Invalid sessionDigest');
  result.sessionDigest=v.sessionDigest;
 }
 return Object.freeze(result);
}
export function validateHostEnrollment(raw){
 const v=object(raw);
 keys(v,['hostId','credentialDigest','ttlSeconds']);
 const hostId=uuid(v.hostId,'hostId');
 if(typeof v.credentialDigest!=='string'||!HEX64.test(v.credentialDigest))throw new TypeError('Invalid credentialDigest');
 const ttlSeconds=v.ttlSeconds??86400;
 if(!Number.isSafeInteger(ttlSeconds)||ttlSeconds<3600||ttlSeconds>604800)throw new RangeError('Invalid host TTL');
 return Object.freeze({hostId,credentialDigest:v.credentialDigest,ttlSeconds});
}
export function validatePendingWakeBinding(raw){
 const v=object(raw);
 keys(v,['roomId','participantId','hostId','sessionDigest','spaceId','sessionId',
   'targetId','targetIdentityFingerprint','targetRevision','surface',
   'locatorKind','locatorValue','participationMode','maxWakesPerMinute']);
 const result={
  roomId:uuid(v.roomId,'roomId'),participantId:uuid(v.participantId,'participantId'),
  hostId:uuid(v.hostId,'hostId'),
  sessionDigest:typeof v.sessionDigest==='string'&&HEX64.test(v.sessionDigest)?v.sessionDigest:(()=>{throw new TypeError('Invalid sessionDigest');})(),
  spaceId:label(v.spaceId,'spaceId',128),sessionId:label(v.sessionId,'sessionId'),
  targetId:label(v.targetId,'targetId',128),
  targetIdentityFingerprint:label(v.targetIdentityFingerprint,'targetIdentityFingerprint',512),
  targetRevision:v.targetRevision,surface:v.surface,locatorKind:v.locatorKind,
  locatorValue:label(v.locatorValue,'locatorValue',2048),
  participationMode:v.participationMode??'mentions',
  maxWakesPerMinute:v.maxWakesPerMinute??6,
 };
 if(!Number.isSafeInteger(result.targetRevision)||result.targetRevision<1||result.targetRevision>2147483647)
  throw new RangeError('Invalid targetRevision');
 if(!SURFACES.has(result.surface)||!LOCATORS.has(result.locatorKind)||!MODES.has(result.participationMode))
  throw new TypeError('Invalid surface, locator or participation mode');
 if(!Number.isSafeInteger(result.maxWakesPerMinute)||result.maxWakesPerMinute<1||result.maxWakesPerMinute>6)
  throw new RangeError('Invalid wake rate');
 return Object.freeze(result);
}
