/**
 * Server-side adapter for the private Supabase Backroom wake queue.
 * Never import this module from browser UI code or pass it a public/anon client.
 * The migration grants its RPCs to service_role only.
 */
import {createHash} from 'node:crypto';
import {validId} from './coordination-core.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX64=/^[0-9a-f]{64}$/;
const LEASE=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ERROR_CODES=new Set(['target_unavailable','approval_required','provider_busy','transport_error','result_unconfirmed','authorization_denied','other']);
function requireMatch(value,re,name){if(typeof value!=='string'||!re.test(value))throw new TypeError('Invalid '+name);return value;}
function requireLabel(value,name,max=256){if(typeof value!=='string'||value.trim()===''||value.length>max||/[\u0000-\u001f]/.test(value))throw new TypeError('Invalid '+name);return value;}
function requireInt(value,name,min,max){if(!Number.isSafeInteger(value)||value<min||value>max)throw new RangeError('Invalid '+name);return value;}
function requireBoolean(value,name){if(typeof value!=='boolean')throw new TypeError('Invalid '+name);return value;}
function rpcError(name,error){const code=typeof error?.code==='string'?error.code:'unknown';const e=new Error('Backroom queue RPC '+name+' failed ('+code+')');e.code='BACKROOM_QUEUE_RPC';throw e;}
async function call(client,name,args){const response=await client.rpc(name,args);if(!response||response.error)rpcError(name,response?.error);return response.data;}
export function createWakeKey(eventId,participantId){
 requireLabel(eventId,'eventId');requireLabel(participantId,'participantId');
 return createHash('sha256').update(JSON.stringify([eventId,participantId]),'utf8').digest('hex');
}
export class SupabaseBackroomWakeStore{
 constructor({client}={}){
  if(typeof window!=='undefined')throw new Error('SupabaseBackroomWakeStore is server-only');
  if(!client||typeof client.rpc!=='function')throw new TypeError('Privileged server-side Supabase RPC client required');
  this.client=client;
 }
 async enqueue(input){
  const p=input?.plan?.job;
  if(input?.plan?.action!=='queue'||!p)throw new TypeError('Eligible wake plan required');
  const target=input.target,binding=input.binding;
  if(!target||!binding)throw new TypeError('Registered target and binding required');
  const args={
   p_job_key:requireMatch(input.jobKey??createWakeKey(p.eventId,p.participantId),HEX64,'jobKey'),
   p_owner_id:requireMatch(input.ownerId,UUID,'ownerId'),
   p_room_id:requireMatch(p.groupId,UUID,'groupId'),
   p_participant_id:requireMatch(p.participantId,UUID,'participantId'),
   p_host_id:requireLabel(target.hostId,'hostId',128),
   p_space_id:requireLabel(target.spaceId,'spaceId',128),
   p_session_id:requireLabel(p.sessionId,'sessionId',256),
   p_session_digest:requireMatch(input.sessionDigest,HEX64,'sessionDigest'),
   p_binding_id:requireLabel(p.bindingId,'bindingId',128),
   p_target_id:requireLabel(p.targetId,'targetId',128),
   p_target_revision:requireInt(target.revision,'targetRevision',1,2147483647),
   p_event_id:requireLabel(p.eventId,'eventId',256),
   p_prompt:requireLabel(p.prompt,'prompt',12000),
   p_ttl_seconds:input.ttlSeconds===undefined?3600:requireInt(input.ttlSeconds,'ttlSeconds',60,86400),
  };
  if(binding.groupId!==p.groupId||binding.participantId!==p.participantId||binding.sessionId!==p.sessionId||
     binding.bindingId!==p.bindingId||binding.targetId!==p.targetId||target.id!==p.targetId||
     target.roomId!==p.groupId||target.sessionId!==p.sessionId)throw new Error('Wake target identity/scope mismatch');
  if(!Array.isArray(binding.capabilities)||!binding.capabilities.includes('draft'))throw new Error('Draft capability required');
  const data=await call(this.client,'enqueue_backroom_wake_job',args);
  if(!data||typeof data!=='object'||!UUID.test(data.job_id)||typeof data.created!=='boolean'||
     !['pending','leased','acknowledged','ignored','failed','cancelled','expired'].includes(data.state))throw new Error('Queue returned malformed enqueue result');
  return Object.freeze({jobId:data.job_id,created:data.created,state:data.state,jobKey:args.p_job_key});
 }
 async claim({hostId,sessionDigest,limit=5,leaseSeconds=30}={}){
  const data=await call(this.client,'claim_backroom_wake_jobs',{
   p_host_id:requireLabel(hostId,'hostId',128),p_session_digest:requireMatch(sessionDigest,HEX64,'sessionDigest'),
   p_limit:requireInt(limit,'limit',1,20),p_lease_seconds:requireInt(leaseSeconds,'leaseSeconds',10,120),
  });
  if(!Array.isArray(data))throw new Error('Queue returned malformed claim result');
  return data.map(row=>{
   if(!row||!UUID.test(row.out_job_id)||!HEX64.test(row.out_job_key)||!LEASE.test(row.out_lease_token)||
      !UUID.test(row.out_owner_id)||!UUID.test(row.out_room_id)||!UUID.test(row.out_participant_id)||
      !Number.isSafeInteger(row.out_attempt_count)||row.out_attempt_count<1||row.out_attempt_count>5||
      !Number.isSafeInteger(row.out_target_revision)||row.out_target_revision<1||
      typeof row.out_prompt!=='string'||!row.out_prompt.startsWith('@RMconnects\n'))throw new Error('Queue returned malformed lease');
   return Object.freeze({jobId:row.out_job_id,jobKey:row.out_job_key,eventId:row.out_event_id,
    ownerId:row.out_owner_id,roomId:row.out_room_id,participantId:row.out_participant_id,
    spaceId:row.out_space_id,sessionId:row.out_session_id,bindingId:row.out_binding_id,
    targetId:row.out_target_id,targetRevision:row.out_target_revision,prompt:row.out_prompt,
    attemptCount:row.out_attempt_count,expiresAt:row.out_expires_at,leaseToken:row.out_lease_token});
  });
 }
 async acknowledge({jobId,hostId,sessionDigest,leaseToken,outcome='acknowledged'}={}){
  requireMatch(jobId,UUID,'jobId');requireLabel(hostId,'hostId',128);requireMatch(sessionDigest,HEX64,'sessionDigest');
  requireMatch(leaseToken,LEASE,'leaseToken');
  if(!['acknowledged','ignored'].includes(outcome))throw new TypeError('Invalid acknowledgement outcome');
  return requireBoolean(await call(this.client,'ack_backroom_wake_job',{
   p_job_id:jobId,p_host_id:hostId,p_session_digest:sessionDigest,p_lease_token:leaseToken,p_outcome:outcome,
  }),'acknowledgement result');
 }
 async retry({jobId,hostId,sessionDigest,leaseToken,retryAfterSeconds=5,errorCode='other'}={}){
  requireMatch(jobId,UUID,'jobId');requireLabel(hostId,'hostId',128);requireMatch(sessionDigest,HEX64,'sessionDigest');
  requireMatch(leaseToken,LEASE,'leaseToken');requireInt(retryAfterSeconds,'retryAfterSeconds',1,300);
  if(!ERROR_CODES.has(errorCode))throw new TypeError('Invalid errorCode');
  const data=await call(this.client,'retry_backroom_wake_job',{
   p_job_id:jobId,p_host_id:hostId,p_session_digest:sessionDigest,p_lease_token:leaseToken,
   p_retry_after_seconds:retryAfterSeconds,p_error_code:errorCode,
  });
  if(data!==null&&!['pending','failed'].includes(data))throw new Error('Queue returned invalid retry state');
  return data;
 }
 async cancel({jobId,ownerId}={}){
  requireMatch(jobId,UUID,'jobId');requireMatch(ownerId,UUID,'ownerId');
  return requireBoolean(await call(this.client,'cancel_backroom_wake_job',{p_job_id:jobId,p_owner_id:ownerId}),'cancellation result');
 }
 async expire(){
  const count=await call(this.client,'expire_backroom_wake_jobs',{});
  if(!Number.isSafeInteger(count)||count<0)throw new Error('Queue returned invalid expiry count');
  return count;
 }
}
