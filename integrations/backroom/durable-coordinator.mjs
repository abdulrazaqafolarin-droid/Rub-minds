/** Routes an authoritative group event into the durable wake queue.
 * This module makes no device calls. The store must be a server-only service-role adapter.
 */
import {planWake} from './coordination-core.mjs';
function nonempty(value,name,max=512){
 if(typeof value!=='string'||value.trim()===''||value.length>max||/[\u0000-\u001f]/.test(value))throw new TypeError('Invalid '+name);
 return value;
}
function uuid(value,name){
 if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))throw new TypeError('Invalid '+name);
 return value;
}
const SURFACES=new Set(['browser_tab','desktop_app','windows_app','terminal','android_app']);
const LOCATORS=new Set(['dom','accessibility','terminal_pty','screen_region']);
export async function routeGroupEventToDurableWake(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw new TypeError('Coordinator input required');
 const {store,event,participant,binding,target,ownerId,sessionDigest,alreadyQueued=false,ttlSeconds}=input;
 if(!store||typeof store.enqueue!=='function')throw new TypeError('Durable wake store required');
 if(ttlSeconds!==undefined&&(!Number.isSafeInteger(ttlSeconds)||ttlSeconds<60||ttlSeconds>86400))throw new RangeError('Invalid ttlSeconds');
 const decision=planWake({event,participant,binding,alreadyQueued});
 if(decision.action!=='queue')return Object.freeze({action:decision.action,reason:decision.reason??null});
 uuid(ownerId,'ownerId');uuid(participant.participantId,'participantId');uuid(participant.groupId,'groupId');
 nonempty(sessionDigest,'sessionDigest',64);
 if(!/^[0-9a-f]{64}$/.test(sessionDigest))throw new TypeError('Invalid sessionDigest');
 if(!target||typeof target!=='object')throw new TypeError('Registered target required');
 for(const [key,value,limit] of [
  ['target.id',target.id,128],['target.roomId',target.roomId,128],['target.hostId',target.hostId,128],
  ['target.spaceId',target.spaceId,128],['target.sessionId',target.sessionId,256],
  ['target.appId',target.appId,256],['target.locatorValue',target.locatorValue,2048],
  ['target.identityFingerprint',target.identityFingerprint,512],
 ])nonempty(value,key,limit);
 if(!Number.isSafeInteger(target.revision)||target.revision<1)throw new TypeError('Invalid target revision');
 if(!SURFACES.has(target.surface)||!LOCATORS.has(target.locatorKind))throw new TypeError('Invalid target surface/locator');
 if(target.id!==binding.targetId||target.roomId!==participant.groupId||
    target.sessionId!==participant.sessionId||binding.groupId!==participant.groupId||
    binding.participantId!==participant.participantId||binding.sessionId!==participant.sessionId||
    binding.targetId!==target.id||!Array.isArray(binding.capabilities)||!binding.capabilities.includes('draft')) {
   throw new Error('Selected input binding does not match participant/group/target');
 }
 const stored=await store.enqueue({
  plan:decision,binding,target,ownerId,sessionDigest,
  ...(ttlSeconds===undefined?{}:{ttlSeconds}),
 });
 if(!stored)throw new Error('Durable wake store returned an invalid enqueue result');
 uuid(stored.jobId,'stored.jobId');
 if(typeof stored.created!=='boolean'||
    !['pending','leased','acknowledged','ignored','failed','cancelled','expired'].includes(stored.state)) {
  throw new Error('Durable wake store returned an invalid enqueue result');
 }
 return Object.freeze({
  action:stored.created?'queued':'duplicate',
  jobId:stored.jobId,
  state:stored.state,
  eventId:decision.job.eventId,
  participantId:decision.job.participantId,
  targetId:decision.job.targetId,
  targetRevision:target.revision,
  expiresInSeconds:ttlSeconds??3600,
 });
}
