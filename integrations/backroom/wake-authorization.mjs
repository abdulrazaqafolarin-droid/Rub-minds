/** In-memory local-host authority for narrowly scoped, trigger-only automation.
 * Grants are destroyed on process restart, bound to one exact target/session, rate limited,
 * and can authorize only canonical @RMconnects prompts. Never use for ordinary Send.
 */
import {createHash,randomUUID} from 'node:crypto';
import {buildCanonicalWakePrompt,isCanonicalWakePrompt,validId} from './coordination-core.mjs';
const sha256=value=>createHash('sha256').update(value,'utf8').digest('hex');
const MIN_TTL=60_000,MAX_TTL=60*60_000;
function requiredId(value,name){if(!validId(value))throw new TypeError('Invalid '+name);return value;}
function nonempty(value,name,max=512){if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f]/.test(value))throw new TypeError('Invalid '+name);return value;}
export class WakeAuthorizationAuthority {
 #grants=new Map();
 #now;
 constructor({now=()=>Date.now(),maxPerMinute=6,maxGrantMs=15*60_000}={}){
  if(typeof now!=='function')throw new TypeError('clock function required');
  if(!Number.isSafeInteger(maxPerMinute)||maxPerMinute<1||maxPerMinute>12)throw new RangeError('maxPerMinute must be 1-12');
  if(!Number.isSafeInteger(maxGrantMs)||maxGrantMs<MIN_TTL||maxGrantMs>MAX_TTL)throw new RangeError('maxGrantMs must be 1-60 minutes');
  this.#now=now;this.maxPerMinute=maxPerMinute;this.maxGrantMs=maxGrantMs;
 }
 createGrant(input={}){
  if(input.confirmed!==true)throw new Error('Explicit user confirmation is required to enable continuous wake triggers');
  const scope={
   hostId:requiredId(input.hostId,'hostId'),groupId:requiredId(input.groupId,'groupId'),
   participantId:requiredId(input.participantId,'participantId'),sessionId:requiredId(input.sessionId,'sessionId'),
   spaceId:requiredId(input.spaceId,'spaceId'),bindingId:requiredId(input.bindingId,'bindingId'),
   targetId:requiredId(input.targetId,'targetId'),
   identityFingerprint:nonempty(input.identityFingerprint,'identityFingerprint'),
   targetRevision:input.targetRevision,
  };
  if(!Number.isSafeInteger(scope.targetRevision)||scope.targetRevision<1)throw new TypeError('Invalid targetRevision');
  const ttlMs=input.ttlMs===undefined?this.maxGrantMs:input.ttlMs;
  if(!Number.isSafeInteger(ttlMs)||ttlMs<MIN_TTL||ttlMs>this.maxGrantMs)throw new RangeError('Invalid wake grant lifetime');
  const maxPerMinute=input.maxPerMinute===undefined?this.maxPerMinute:input.maxPerMinute;
  if(!Number.isSafeInteger(maxPerMinute)||maxPerMinute<1||maxPerMinute>this.maxPerMinute)throw new RangeError('Invalid wake rate limit');
  const grantId=randomUUID(),now=this.#now();
  this.#grants.set(grantId,{...scope,grantId,createdAt:now,expiresAt:now+ttlMs,maxPerMinute,usedCommands:new Set(),uses:[]});
  return Object.freeze({grantId,createdAt:now,expiresAt:now+ttlMs,maxPerMinute,scope:Object.freeze({...scope})});
 }
 verify(grantId,context,{consume=true}={}){
  if(typeof grantId!=='string'||!/^([a-f0-9-]{36})$/i.test(grantId)||!context||typeof context!=='object')return false;
  const grant=this.#grants.get(grantId),now=this.#now();
  if(!grant||now>=grant.expiresAt||context.purpose!=='backroom.wake.v1'||context.operation!=='wake'||
    !validId(context.commandId)||!validId(context.eventId)||
    !isCanonicalWakePrompt(buildCanonicalWakePrompt(context.eventId),context.eventId)||
    context.textSha256!==sha256(buildCanonicalWakePrompt(context.eventId)))return false;
  for(const key of ['hostId','groupId','participantId','sessionId','spaceId','bindingId','targetId','identityFingerprint','targetRevision']){
   if(context[key]!==grant[key])return false;
  }
  if(grant.usedCommands.has(context.commandId))return false;
  const recent=grant.uses.filter(at=>now-at<60_000);
  if(recent.length>=grant.maxPerMinute)return false;
  if(consume){grant.usedCommands.add(context.commandId);grant.uses=[...recent,now];}
  return true;
 }
 revoke(grantId){return this.#grants.delete(grantId);}
 status(grantId){
  const g=this.#grants.get(grantId);
  if(!g)return Object.freeze({active:false,reason:'missing-or-revoked'});
  if(this.#now()>=g.expiresAt){this.#grants.delete(grantId);return Object.freeze({active:false,reason:'expired'});}
  const recent=g.uses.filter(at=>this.#now()-at<60_000);
  return Object.freeze({active:true,expiresAt:g.expiresAt,usedCommands:g.usedCommands.size,remainingThisMinute:Math.max(0,g.maxPerMinute-recent.length),scope:Object.freeze({hostId:g.hostId,groupId:g.groupId,participantId:g.participantId,sessionId:g.sessionId,spaceId:g.spaceId,bindingId:g.bindingId,targetId:g.targetId,identityFingerprint:g.identityFingerprint,targetRevision:g.targetRevision})});
 }
}
