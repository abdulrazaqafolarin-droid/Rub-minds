/**
 * Separate short-lived handoff contract for a durable Backroom wake lease
 * travelling from a trusted host worker to a selected native companion.
 *
 * This is NOT a queue claim API, signature verifier or OS driver. The sender
 * must already hold a host-scoped durable lease and the receiver must arrive
 * over an authenticated device/session channel. Native local consent, the
 * persistent execution seal and final accessibility revalidation remain
 * mandatory before any Send side effect.
 */
import {createHash,randomUUID} from 'node:crypto';
import {buildCanonicalWakePrompt,isCanonicalWakePrompt,validId} from './coordination-core.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX=/^[a-f0-9]{64}$/;
const SURFACES=new Set(['android_app','windows_app','desktop_app']);
const REASONS=new Set([
 'foreground_changed','composer_not_empty','composer_identity_changed',
 'send_control_unavailable','send_identity_changed','conversation_scope_unavailable','permission_denied',
 'device_disconnected','send_unconfirmed','outcome_unknown','other',
]);
const MAX_HANDOFF_TTL_MS=20_000;
const MAX_ATTEMPTS_PER_JOB=5;
const MAX_TRACKED_JOBS=4096;
const MAX_TRACKED_HANDOFFS=8192;

const sha256=value=>createHash('sha256').update(value,'utf8').digest('hex');
const nonempty=(value,max=512)=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\u0000-\u001f\u007f-\u009f]/.test(value);
function exactKeys(value,keys){
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
}
function validLease(lease){
 return exactKeys(lease,['jobId','leaseToken','eventId','roomId','bindingId','hostId','sessionId',
  'targetId','targetIdentityFingerprint','providerConversationIdentityDigest','targetRevision','prompt','promptDigest','expiresAt'])&&
  UUID.test(lease.jobId??'')&&validId(lease.eventId)&&
  UUID.test(lease.leaseToken??'')&&UUID.test(lease.roomId??'')&&
  UUID.test(lease.bindingId??'')&&nonempty(lease.hostId,128)&&
  nonempty(lease.sessionId,256)&&nonempty(lease.targetId,128)&&
  nonempty(lease.targetIdentityFingerprint)&&HEX.test(lease.providerConversationIdentityDigest??'')&&Number.isSafeInteger(lease.targetRevision)&&lease.targetRevision>0&&
  Number.isSafeInteger(lease.expiresAt)&&isCanonicalWakePrompt(lease.prompt,lease.eventId)&&
  HEX.test(lease.promptDigest??'')&&sha256(lease.prompt)===lease.promptDigest;
}
function validScope(scope){
 return exactKeys(scope,['deviceId','roomId','screenSessionId','bindingId','hostId','sessionId',
  'targetId','targetRevision','surface','appId','identityFingerprint','composerIdentityDigest',
  'sendControlIdentityDigest','providerConversationIdentityDigest'])&&
  UUID.test(scope.deviceId??'')&&UUID.test(scope.roomId??'')&&
  UUID.test(scope.screenSessionId??'')&&UUID.test(scope.bindingId??'')&&
  nonempty(scope.hostId,128)&&nonempty(scope.sessionId,256)&&
  nonempty(scope.targetId,128)&&Number.isSafeInteger(scope.targetRevision)&&scope.targetRevision>0&&
  SURFACES.has(scope.surface)&&nonempty(scope.appId,256)&&
  nonempty(scope.identityFingerprint)&&HEX.test(scope.composerIdentityDigest??'')&&
  HEX.test(scope.sendControlIdentityDigest??'')&&HEX.test(scope.providerConversationIdentityDigest??'');
}
function leaseMatchesScope(lease,scope){
 return lease.hostId===scope.hostId&&lease.roomId===scope.roomId&&
  lease.bindingId===scope.bindingId&&lease.sessionId===scope.sessionId&&
  lease.targetId===scope.targetId&&lease.targetRevision===scope.targetRevision&&
  lease.targetIdentityFingerprint===scope.identityFingerprint&&
  lease.providerConversationIdentityDigest===scope.providerConversationIdentityDigest;
}
function buildScopeFields(scope){
 return {
  deviceId:scope.deviceId.toLowerCase(),roomId:scope.roomId.toLowerCase(),
  screenSessionId:scope.screenSessionId.toLowerCase(),hostId:scope.hostId,
  bindingId:scope.bindingId.toLowerCase(),sessionId:scope.sessionId,
  targetId:scope.targetId,targetRevision:scope.targetRevision,surface:scope.surface,
  appId:scope.appId,identityFingerprint:scope.identityFingerprint,
  composerIdentityDigest:scope.composerIdentityDigest.toLowerCase(),
  sendControlIdentityDigest:scope.sendControlIdentityDigest.toLowerCase(),
  providerConversationIdentityDigest:scope.providerConversationIdentityDigest.toLowerCase(),
 };
}

export function createNativeWakeHandoff(lease,scope,{now=Date.now(),handoffId=randomUUID()}={}){
 if(!validLease(lease))throw new TypeError('A valid canonical durable wake lease is required');
 if(!validScope(scope)||!leaseMatchesScope(lease,scope))
  throw new TypeError('Native device, room, stream, binding or target scope mismatch');
 if(!UUID.test(handoffId)||!Number.isSafeInteger(now)||now<0)
  throw new TypeError('Invalid native wake handoff identity or clock');
 if(lease.expiresAt<=now+250)throw new Error('Durable wake lease is too close to expiry');
 const expiresAt=Math.min(lease.expiresAt,now+MAX_HANDOFF_TTL_MS);
 const handoff=Object.freeze({
  version:1,kind:'native_wake_trigger',handoffId:handoffId.toLowerCase(),
  jobId:lease.jobId.toLowerCase(),eventId:lease.eventId,
  ...buildScopeFields(scope),leaseTokenDigest:sha256(lease.leaseToken),
  prompt:buildCanonicalWakePrompt(lease.eventId),promptDigest:lease.promptDigest,
  issuedAt:now,leaseExpiresAt:lease.expiresAt,expiresAt,
 });
 return handoff;
}

const HANDOFF_KEYS=[
 'version','kind','handoffId','jobId','eventId','deviceId','roomId','screenSessionId',
 'hostId','bindingId','sessionId','targetId','targetRevision','surface','appId',
 'identityFingerprint','composerIdentityDigest','sendControlIdentityDigest','providerConversationIdentityDigest',
 'leaseTokenDigest','prompt','promptDigest','issuedAt','leaseExpiresAt','expiresAt',
];
export function validateNativeWakeHandoff(payload,expected,{now=Date.now(),clockSkewMs=3_000}={}){
 if(!exactKeys(payload,HANDOFF_KEYS)||!validScope(expected)||
  payload.version!==1||payload.kind!=='native_wake_trigger'||
  !UUID.test(payload.handoffId??'')||!UUID.test(payload.jobId??'')||
  !validId(payload.eventId)||!HEX.test(payload.leaseTokenDigest??'')||
  !nonempty(payload.hostId,128)||!nonempty(payload.sessionId,256)||
  !nonempty(payload.targetId,128)||!Number.isSafeInteger(payload.targetRevision)||payload.targetRevision<1||
  !nonempty(payload.appId,256)||!nonempty(payload.identityFingerprint)||
  !HEX.test(payload.composerIdentityDigest??'')||!HEX.test(payload.sendControlIdentityDigest??'')||
  !HEX.test(payload.providerConversationIdentityDigest??'')||
  !SURFACES.has(payload.surface)||!isCanonicalWakePrompt(payload.prompt,payload.eventId)||
  !HEX.test(payload.promptDigest??'')||sha256(payload.prompt)!==payload.promptDigest||
  !Number.isSafeInteger(payload.issuedAt)||!Number.isSafeInteger(payload.leaseExpiresAt)||
  !Number.isSafeInteger(payload.expiresAt)||!Number.isSafeInteger(now)||
  !Number.isSafeInteger(clockSkewMs)||clockSkewMs<0||clockSkewMs>10_000||
  payload.issuedAt>now+clockSkewMs||payload.expiresAt<=now||
  payload.leaseExpiresAt<=now||payload.expiresAt>payload.leaseExpiresAt||
  payload.expiresAt-payload.issuedAt>MAX_HANDOFF_TTL_MS||
  payload.issuedAt>=payload.leaseExpiresAt||
  payload.deviceId!==expected.deviceId.toLowerCase()||
  payload.roomId!==expected.roomId.toLowerCase()||
  payload.screenSessionId!==expected.screenSessionId.toLowerCase()||
  payload.hostId!==expected.hostId||payload.bindingId!==expected.bindingId.toLowerCase()||
  payload.sessionId!==expected.sessionId||payload.targetId!==expected.targetId||
  payload.targetRevision!==expected.targetRevision||payload.surface!==expected.surface||
  payload.appId!==expected.appId||payload.identityFingerprint!==expected.identityFingerprint||
  payload.composerIdentityDigest!==expected.composerIdentityDigest.toLowerCase()||
  payload.sendControlIdentityDigest!==expected.sendControlIdentityDigest.toLowerCase()||
  payload.providerConversationIdentityDigest!==expected.providerConversationIdentityDigest.toLowerCase())return null;
 return Object.freeze({...payload});
}

function validateOutcome(result){
 const allowed=['state','promptInserted','sendInvoked','composerCleared','promptReadbackVerified',
  'composerIdentityRevalidated','sendControlIdentityRevalidated','composerIdentityDigest',
  'sendControlIdentityDigest','providerConversationIdentityRevalidated','providerConversationIdentityDigest','reason'];
 if(!result||typeof result!=='object'||Array.isArray(result)||
  Object.keys(result).some(key=>!allowed.includes(key))||
  !['preflight_denied','submitted','needs_review'].includes(result.state)||
  typeof result.promptInserted!=='boolean'||typeof result.sendInvoked!=='boolean'||
  typeof result.composerCleared!=='boolean'||
  (result.reason!==undefined&&!REASONS.has(result.reason)))return false;
 if(result.state==='preflight_denied')
  return result.promptInserted===false&&result.sendInvoked===false&&result.composerCleared===false&&
   (result.reason===undefined||result.reason!=='outcome_unknown');
 if(result.state==='submitted')
  return result.promptInserted===true&&result.sendInvoked===true&&result.composerCleared===true&&
   result.promptReadbackVerified===true&&result.composerIdentityRevalidated===true&&
   result.sendControlIdentityRevalidated===true&&HEX.test(result.composerIdentityDigest??'')&&
   HEX.test(result.sendControlIdentityDigest??'')&&result.providerConversationIdentityRevalidated===true&&
   HEX.test(result.providerConversationIdentityDigest??'');
 return true;
}

export function createNativeWakeHandoffResult(handoff,result){
 if(!handoff||!UUID.test(handoff.handoffId??'')||!UUID.test(handoff.jobId??'')||
  !UUID.test(handoff.deviceId??'')||!UUID.test(handoff.roomId??'')||
  !UUID.test(handoff.screenSessionId??'')||!validateOutcome(result)||
  (result.state==='submitted'&&(
   result.composerIdentityDigest!==handoff.composerIdentityDigest||
   result.sendControlIdentityDigest!==handoff.sendControlIdentityDigest||
   result.providerConversationIdentityDigest!==handoff.providerConversationIdentityDigest)))
  throw new TypeError('Invalid native wake handoff result');
 return Object.freeze({
  version:1,kind:'native_wake_result',handoffId:handoff.handoffId,
  jobId:handoff.jobId,deviceId:handoff.deviceId,roomId:handoff.roomId,
  screenSessionId:handoff.screenSessionId,bindingId:handoff.bindingId,
  targetId:handoff.targetId,targetRevision:handoff.targetRevision,
  state:result.state,promptInserted:result.promptInserted,
  sendInvoked:result.sendInvoked,composerCleared:result.composerCleared,
  ...(result.state==='submitted'?{
   promptReadbackVerified:true,composerIdentityRevalidated:true,
   sendControlIdentityRevalidated:true,
   providerConversationIdentityRevalidated:true,
   composerIdentityDigest:handoff.composerIdentityDigest,
   sendControlIdentityDigest:handoff.sendControlIdentityDigest,
   providerConversationIdentityDigest:handoff.providerConversationIdentityDigest,
  }:{}),
  ...(result.reason?{reason:result.reason}:{}),
 });
}
function outcomeFromHandoffResult(result){
 const keys=['state','promptInserted','sendInvoked','composerCleared','promptReadbackVerified',
  'composerIdentityRevalidated','sendControlIdentityRevalidated','composerIdentityDigest',
  'sendControlIdentityDigest','providerConversationIdentityRevalidated','providerConversationIdentityDigest','reason'];
 return Object.fromEntries(keys.filter(key=>Object.hasOwn(result,key)).map(key=>[key,result[key]]));
}
const RESULT_KEYS=new Set([
 'version','kind','handoffId','jobId','deviceId','roomId','screenSessionId',
 'bindingId','targetId','targetRevision','state','promptInserted','sendInvoked',
 'composerCleared','promptReadbackVerified','composerIdentityRevalidated',
 'sendControlIdentityRevalidated','composerIdentityDigest','sendControlIdentityDigest',
 'providerConversationIdentityRevalidated','providerConversationIdentityDigest','reason',
]);
const REQUIRED_RESULT_KEYS=[
 'version','kind','handoffId','jobId','deviceId','roomId','screenSessionId',
 'bindingId','targetId','targetRevision','state','promptInserted','sendInvoked','composerCleared',
];
export function validateNativeWakeHandoffResult(result,handoff){
 if(!result||typeof result!=='object'||Array.isArray(result)||
  !REQUIRED_RESULT_KEYS.every(key=>Object.hasOwn(result,key))||
  Object.keys(result).some(key=>!RESULT_KEYS.has(key))||
  result.version!==1||result.kind!=='native_wake_result'||
  result.handoffId!==handoff?.handoffId||result.jobId!==handoff?.jobId||
  result.deviceId!==handoff?.deviceId||result.roomId!==handoff?.roomId||
  result.screenSessionId!==handoff?.screenSessionId||result.bindingId!==handoff?.bindingId||
  result.targetId!==handoff?.targetId||result.targetRevision!==handoff?.targetRevision||
  !validateOutcome(outcomeFromHandoffResult(result)))return false;
 if(result.state==='submitted'&&(
  result.promptReadbackVerified!==true||result.composerIdentityRevalidated!==true||
  result.sendControlIdentityRevalidated!==true||
  result.composerIdentityDigest!==handoff.composerIdentityDigest||
  result.sendControlIdentityDigest!==handoff.sendControlIdentityDigest||
  result.providerConversationIdentityRevalidated!==true||
  result.providerConversationIdentityDigest!==handoff.providerConversationIdentityDigest))return false;
 if(result.state!=='submitted'&&(
  result.promptReadbackVerified!==undefined||result.composerIdentityRevalidated!==undefined||
  result.sendControlIdentityRevalidated!==undefined||
  result.composerIdentityDigest!==undefined||result.sendControlIdentityDigest!==undefined||
  result.providerConversationIdentityRevalidated!==undefined||
  result.providerConversationIdentityDigest!==undefined))return false;
 return true;
}

export class NativeWakeHandoffReceiver {
 #expected;#now;#jobs=new Map();#handoffs=new Map();
 constructor({scope,now=()=>Date.now(),maxJobs=MAX_TRACKED_JOBS,maxHandoffs=MAX_TRACKED_HANDOFFS}={}){
  if(!validScope(scope)||typeof now!=='function'||!Number.isSafeInteger(maxJobs)||maxJobs<1||
   !Number.isSafeInteger(maxHandoffs)||maxHandoffs<maxJobs)
   throw new TypeError('Valid native companion wake receiver scope required');
  this.#expected=Object.freeze({...scope});this.#now=now;
  this.maxJobs=maxJobs;this.maxHandoffs=maxHandoffs;
 }
 accept(payload){
  const handoff=validateNativeWakeHandoff(payload,this.#expected,{now:this.#now()});
  if(!handoff)return null;
  if(this.#handoffs.size>=this.maxHandoffs)return null;
  let job=this.#jobs.get(handoff.jobId);
  if(!job){
   if(this.#jobs.size>=this.maxJobs)return null;
   job={activeHandoffId:null,terminal:false,attempts:0,leaseTokens:new Set()};
   this.#jobs.set(handoff.jobId,job);
  }
  if(job.terminal||job.activeHandoffId||job.attempts>=MAX_ATTEMPTS_PER_JOB)return null;
  if(job.leaseTokens.has(handoff.leaseTokenDigest))return null;
  job.leaseTokens.add(handoff.leaseTokenDigest);
  job.attempts+=1;job.activeHandoffId=handoff.handoffId;
  this.#handoffs.set(handoff.handoffId,{jobId:handoff.jobId,state:'accepted',handoff});
  return handoff;
 }
 settle(handoffId,result){
  const entry=this.#handoffs.get(handoffId),job=entry?this.#jobs.get(entry.jobId):null;
  if(!entry||entry.state!=='accepted'||!job||job.activeHandoffId!==handoffId)return null;
  const accepted=entry.handoff;
  const evidence=result&&typeof result==='object'&&!Array.isArray(result)?result:{};
  const handoffScope={
   handoffId,jobId:entry.jobId,deviceId:accepted.deviceId,
   roomId:accepted.roomId,screenSessionId:accepted.screenSessionId,
   bindingId:accepted.bindingId,targetId:accepted.targetId,
   targetRevision:accepted.targetRevision,
  };
  if(!validateOutcome(evidence)||
   (evidence.state==='submitted'&&(
    evidence.composerIdentityDigest!==accepted.composerIdentityDigest||
    evidence.sendControlIdentityDigest!==accepted.sendControlIdentityDigest)))return null;
  const ack=Object.freeze({
   version:1,kind:'native_wake_result',...handoffScope,
   state:evidence.state,promptInserted:evidence.promptInserted,
   sendInvoked:evidence.sendInvoked,composerCleared:evidence.composerCleared,
   ...(evidence.state==='submitted'?{
    promptReadbackVerified:evidence.promptReadbackVerified,
    composerIdentityRevalidated:evidence.composerIdentityRevalidated,
    sendControlIdentityRevalidated:evidence.sendControlIdentityRevalidated,
    composerIdentityDigest:evidence.composerIdentityDigest,
    sendControlIdentityDigest:evidence.sendControlIdentityDigest,
   }:{}),
   ...(evidence.reason?{reason:evidence.reason}:{}),
  });
  if(!validateNativeWakeHandoffResult(ack,accepted))return null;
  entry.state=evidence.state;
  if(evidence.state==='preflight_denied')job.activeHandoffId=null;
  else {job.activeHandoffId=null;job.terminal=true;}
  return ack;
 }
 status(jobId){
  const job=this.#jobs.get(jobId);
  if(!job)return Object.freeze({known:false});
  return Object.freeze({known:true,terminal:job.terminal,attempts:job.attempts,
   active:job.activeHandoffId!==null,state:job.activeHandoffId?this.#handoffs.get(job.activeHandoffId)?.state:
    (job.terminal?'terminal':'retryable')});
 }
}
