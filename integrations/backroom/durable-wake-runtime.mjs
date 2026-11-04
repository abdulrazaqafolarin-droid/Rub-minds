/** Consume one durable wake lease through the existing local dispatcher. Trigger-only.
 * verifyApproval is a non-consuming preflight; the dispatched host must atomically consume
 * the exact grant before the adapter effect. Never pass a verifier that consumes here. */
import {createHash} from 'node:crypto';
import {isCanonicalWakePrompt,mayDispatchWake} from './coordination-core.mjs';
import {approvalContext} from './coordination-dispatch-bridge.mjs';
const ID=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const PROVIDER_IDENTITY_DIGEST=/^[a-f0-9]{64}$/;
const NATIVE_WAKE_SURFACES=new Set(["desktop_app","windows_app","android_app"]);
function id(v,n){if(typeof v!=='string'||!ID.test(v))throw new TypeError('Invalid '+n);return v;}
function required(v,n){if(typeof v!=='string'||v.trim()==='')throw new TypeError(n+' required');return v;}
function leaseInput(lease){
 if(!lease||typeof lease!=='object')throw new TypeError('Claimed wake lease required');
 for(const [key,value] of [['jobId',lease.jobId],['eventId',lease.eventId],['roomId',lease.roomId],['participantId',lease.participantId],['hostId',lease.hostId],['sessionId',lease.sessionId],['bindingId',lease.bindingId],['targetId',lease.targetId]])id(value,'lease.'+key);
 required(lease.spaceId,'lease.spaceId');
 required(lease.targetIdentityFingerprint,'lease.targetIdentityFingerprint');
 required(lease.prompt,'lease.prompt');
 if(!isCanonicalWakePrompt(lease.prompt,lease.eventId)||lease.prompt.length>12000)throw new TypeError('Invalid canonical wake prompt');
 if(!/^[0-9a-f]{64}$/.test(lease.promptDigest)||createHash('sha256').update(lease.prompt,'utf8').digest('hex')!==lease.promptDigest)throw new TypeError('Wake prompt digest mismatch');
 id(lease.leaseToken,'lease.leaseToken');
 if(!/^[0-9a-f]{64}$/.test(lease.sessionDigest))throw new TypeError('Invalid session digest');
 if(lease.providerConversationIdentityDigest!==undefined &&
  !PROVIDER_IDENTITY_DIGEST.test(lease.providerConversationIdentityDigest))
  throw new TypeError('Invalid provider conversation identity digest');
 if(!Number.isSafeInteger(lease.targetRevision)||lease.targetRevision<1)throw new TypeError('Invalid target revision');
 return lease;
}
export function commandFromClaimedWake({lease:raw,targetRegistry,hostId,binding,participant,sessionDigest,wakeGrantId}={}){
 const lease=leaseInput(raw);
 id(hostId,'hostId');
 if(hostId!==lease.hostId||sessionDigest!==lease.sessionDigest)throw new Error('Claimed wake belongs to a different host/session digest');
 if(!targetRegistry||typeof targetRegistry.resolve!=='function')throw new TypeError('TargetRegistry required');
 if(!binding||!participant)throw new TypeError('Binding and participant required');
 if(binding.groupId!==lease.roomId||binding.participantId!==lease.participantId||binding.sessionId!==lease.sessionId||
  binding.bindingId!==lease.bindingId||binding.targetId!==lease.targetId||!Array.isArray(binding.capabilities)||!binding.capabilities.includes('wake')) {
  throw new Error('Wake lease does not match the selected input binding');
 }
 if(participant.groupId!==lease.roomId||participant.participantId!==lease.participantId||participant.sessionId!==lease.sessionId) {
  throw new Error('Wake lease does not match the authenticated AI participant');
 }
 id(wakeGrantId,'wakeGrantId');
 const target=targetRegistry.resolve(lease.targetId,{
  roomId:lease.roomId,hostId,spaceId:lease.spaceId,sessionId:lease.sessionId,
  identityFingerprint:lease.targetIdentityFingerprint,
  ...(lease.providerConversationIdentityDigest!==undefined
   ? {expectedProviderConversationIdentityDigest:lease.providerConversationIdentityDigest} : {}),
  expectedRevision:lease.targetRevision,
 });
 if(NATIVE_WAKE_SURFACES.has(target.surface) &&
  (!PROVIDER_IDENTITY_DIGEST.test(lease.providerConversationIdentityDigest??"") ||
   target.providerConversationIdentityDigest!==lease.providerConversationIdentityDigest)) {
  throw new Error("Native wake requires the exact provider conversation identity in both the durable lease and selected target");
 }
 const command=Object.freeze({
  id:'wake_'+lease.jobId.replaceAll('-',''),eventId:lease.eventId,roomId:lease.roomId,hostId,
  spaceId:lease.spaceId,sessionId:lease.sessionId,identityFingerprint:lease.targetIdentityFingerprint,
  ...(lease.providerConversationIdentityDigest!==undefined
   ? {providerConversationIdentityDigest:lease.providerConversationIdentityDigest} : {}),
  participantId:lease.participantId,bindingId:lease.bindingId,targetId:lease.targetId,targetRevision:lease.targetRevision,operation:'wake',wakeGrantId,text:lease.prompt,
 });
 return Object.freeze({command,target,job:Object.freeze({
  jobId:lease.jobId,eventId:lease.eventId,groupId:lease.roomId,participantId:lease.participantId,
  sessionId:lease.sessionId,bindingId:lease.bindingId,targetId:lease.targetId,
  requiresApproval:true,requestedAction:'wake',prompt:lease.prompt,
 })});
}
async function queueRetry(store,lease,errorCode,reason){
 try {
  const state=await store.retry({jobId:lease.jobId,hostId:lease.hostId,sessionDigest:lease.sessionDigest,bindingId:lease.bindingId,
   leaseToken:lease.leaseToken,retryAfterSeconds:5,errorCode});
  return Object.freeze({state:state==='pending'?'deferred':'failed',reason:reason,queueState:state});
 } catch {
  return Object.freeze({state:'lease-lost',reason:reason});
 }
}
async function queueAck(store,lease,outcome,reason){
 try {
  const acknowledged=await store.acknowledge({jobId:lease.jobId,hostId:lease.hostId,
   sessionDigest:lease.sessionDigest,bindingId:lease.bindingId,leaseToken:lease.leaseToken,outcome});
  return Object.freeze({state:acknowledged?(outcome==='acknowledged'?'completed':'ignored'):'lease-lost',
   reason:reason??null,acknowledged:acknowledged});
 } catch {
  return Object.freeze({state:'lease-lost',reason:reason??'acknowledgement-failed',acknowledged:false});
 }
}
export async function dispatchClaimedWake(input){
 const lease=leaseInput(input?.lease);
 const store=input?.store,dispatcher=input?.dispatcher;
 if(!store||typeof store.retry!=='function'||typeof store.acknowledge!=='function')throw new TypeError('Durable wake store required');
 if(!dispatcher||typeof dispatcher.enqueue!=='function'||typeof dispatcher.status!=='function'||typeof dispatcher.step!=='function')throw new TypeError('BackroomDispatcher required');
 const hasExecutionSeal=input?.executionSeal!==undefined||input?.consumeApproval!==undefined;
 if(hasExecutionSeal&&(typeof input.executionSeal!=='function'||typeof input.consumeApproval!=='function'))
  throw new TypeError('Execution seal and one-shot grant consumer must be supplied together');
 if(input?.approval==null||typeof input.verifyApproval!=='function')return queueRetry(store,lease,'approval_required','wake-authorization-required');
 const wakeGrantId=input.approval?.grantId;
 let mapped;
 try {
  mapped=commandFromClaimedWake({lease,targetRegistry:input.targetRegistry,hostId:input.hostId,
   binding:input.binding,participant:input.participant,sessionDigest:input.sessionDigest,wakeGrantId});
 } catch {
  // Do not retarget a stale lease to a replacement control. Consume it as ignored;
  // the user must reselect/rebind the intended input before another wake.
  return queueAck(store,lease,'ignored','target-or-session-binding-stale');
 }
 let verified=false;
 try {verified=(await input.verifyApproval(input.approval,approvalContext(mapped.command)))===true;} catch {verified=false;}
 if(!verified)return queueAck(store,lease,'ignored','wake-authorization-invalid-or-replayed');
 const gate=mayDispatchWake({job:mapped.job,binding:input.binding,participant:input.participant,
  authorizationValid:true,composerEmpty:input.composerEmpty,foregroundSessionId:input.foregroundSessionId});
 if(!gate.ok) {
  if(['composer-not-empty','session-mismatch','session-not-ready'].includes(gate.reason)) {
   return queueRetry(store,lease,'target_unavailable',gate.reason);
  }
  return queueAck(store,lease,'ignored',gate.reason);
 }
 let status;
 try {status=dispatcher.enqueue(mapped.command);} catch {
  return queueRetry(store,lease,'transport_error','dispatcher-enqueue-failed');
 }
 if(!status||typeof status.state!=='string')return queueRetry(store,lease,'transport_error','invalid-dispatcher-status');
 let executionSealAttempted=false;
 const beforeEffect=hasExecutionSeal?async()=>{
  executionSealAttempted=true;
  // The local host must reserve the durable one-time seal, then consume the
  // exact in-memory grant. This callback runs only after the guard's live
  // app/composer and local permission checks have succeeded.
  const sealed=await input.executionSeal(mapped.command);
  if(sealed!==true)return false;
  return (await input.consumeApproval(input.approval,approvalContext(mapped.command)))===true;
 }:undefined;
 if(['queued','awaiting_approval'].includes(status.state)) {
  try {status=await dispatcher.step(mapped.command.id,{approved:true,...(beforeEffect?{beforeEffect}:{})});}
  catch {return queueAck(store,lease,'ignored','dispatcher-outcome-unknown');}
 }
 if(status?.state==='completed')return queueAck(store,lease,'acknowledged',null);
 if(status?.state==='failed'&&status.reason==='device_preflight_denied'&&!executionSealAttempted) {
  // The local guard denied before the seal/grant hook ran, so this lease can
  // safely be retried without risking a duplicate provider submission.
  return queueRetry(store,lease,'target_unavailable','host-preflight-denied');
 }
 // Ambiguous/failed effects must not be blindly replayed. Mark the wake ignored;
 // a human may rebind and explicitly initiate a fresh wake.
 return queueAck(store,lease,'ignored',status?.reason??status?.state??'unknown-dispatcher-outcome');
}
