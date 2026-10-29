/** Bridges coordinator wake plans to BackroomDispatcher. Draft-only; no automatic Send. */
import {createHash} from 'node:crypto';
import {mayDispatch,validId} from './coordination-core.mjs';
const MAX_PENDING=256;
const TERMINAL=new Set(['completed','failed','cancelled','needs_review']);
const commandRecords=new WeakMap();
function requireText(v,n){if(typeof v!=='string'||v.trim()==='')throw new TypeError(n+' is required');return v;}
function requireId(v,n){if(!validId(v))throw new TypeError(n+' is invalid');return v;}
function stableId(eventId,participantId,groupId){return 'wake_'+createHash('sha256').update(JSON.stringify([groupId,eventId,participantId]),'utf8').digest('hex');}
function recordsFor(dispatcher){let r=commandRecords.get(dispatcher);if(!r){r=new Map();commandRecords.set(dispatcher,r);}return r;}
export function createDispatcherCommand(input){
 const plan=input.plan,b=input.binding,p=input.participant,t=input.target;
 if(plan?.action!=='queue'||!plan.job)throw new TypeError('queue wake plan required');
 if(!b||!p||!t)throw new TypeError('binding, participant and resolved target required');
 const j=plan.job;
 for(const pair of [['eventId',j.eventId],['groupId',j.groupId],['participantId',j.participantId],['sessionId',j.sessionId],['bindingId',j.bindingId],['targetId',j.targetId]])requireId(pair[1],pair[0]);
 if(j.requiresApproval!==true||j.requestedAction!=='draft'||typeof j.prompt!=='string'||!j.prompt.startsWith('@RMconnects\n')||j.prompt.length>12000)throw new Error('wake plan is not a bounded approval-gated draft');
 if(!Array.isArray(b.capabilities)||!b.capabilities.includes('draft'))throw new Error('draft capability missing');
 if(b.groupId!==j.groupId||b.participantId!==j.participantId||b.sessionId!==j.sessionId||b.bindingId!==j.bindingId||b.targetId!==j.targetId)throw new Error('wake plan and input binding disagree');
 if(p.groupId!==j.groupId||p.participantId!==j.participantId||p.sessionId!==j.sessionId||p.status!=='ready')throw new Error('participant identity/state mismatch');
 for(const k of ['id','roomId','hostId','spaceId','sessionId','appId','identityFingerprint'])requireText(t[k],'target.'+k);
 if(t.id!==b.targetId||t.roomId!==b.groupId||t.sessionId!==b.sessionId)throw new Error('resolved target does not belong to selected group/session');
 if(!Number.isSafeInteger(t.revision)||t.revision<1)throw new Error('invalid target revision');
 return Object.freeze({id:stableId(j.eventId,j.participantId,j.groupId),participantId:j.participantId,bindingId:j.bindingId,eventId:j.eventId,
  roomId:j.groupId,hostId:t.hostId,spaceId:t.spaceId,sessionId:t.sessionId,identityFingerprint:t.identityFingerprint,
  targetId:t.id,targetRevision:t.revision,operation:'draft',text:j.prompt});
}
export function approvalContext(c){
 if(!c||typeof c!=='object'||c.operation!=='draft'||typeof c.text!=='string')throw new TypeError('valid draft command required');
 if(!Number.isSafeInteger(c.targetRevision)||c.targetRevision<1)throw new TypeError('valid target revision required');
 return Object.freeze({purpose:'backroom.wake.draft.v1',commandId:requireId(c.id,'command.id'),eventId:requireId(c.eventId,'command.eventId'),
  groupId:requireId(c.roomId,'command.roomId'),hostId:requireId(c.hostId,'command.hostId'),spaceId:requireId(c.spaceId,'command.spaceId'),
  sessionId:requireId(c.sessionId,'command.sessionId'),targetId:requireId(c.targetId,'command.targetId'),
  participantId:requireId(c.participantId,'command.participantId'),bindingId:requireId(c.bindingId,'command.bindingId'),
  identityFingerprint:requireText(c.identityFingerprint,'command.identityFingerprint'),targetRevision:c.targetRevision,operation:c.operation,
  textSha256:createHash('sha256').update(c.text,'utf8').digest('hex')});
}
export function enqueueWakePlan(input){
 const d=input.dispatcher;
 if(!d||typeof d.enqueue!=='function'||typeof d.status!=='function'||typeof d.step!=='function')throw new TypeError('BackroomDispatcher-compatible instance required');
 if(input.plan?.action!=='queue')return Object.freeze({action:input.plan?.action??'skip',reason:input.plan?.reason??'not-eligible'});
 const c=createDispatcherCommand(input),r=recordsFor(d),existing=r.get(c.id);
 if(existing&&JSON.stringify(existing.command)!==JSON.stringify(c))throw new Error('wake command ID conflict');
 if(!existing&&r.size>=MAX_PENDING)throw new Error('pending wake approval capacity reached');
 const s=d.enqueue(c);
 if(!s||typeof s.state!=='string')throw new Error('dispatcher returned invalid status');
 if(['queued','awaiting_approval'].includes(s.state)){r.set(c.id,{command:c,job:Object.freeze({...input.plan.job,jobId:c.id}),binding:input.binding,participant:input.participant});return Object.freeze({action:'queued',commandId:c.id,state:s.state});}
 return Object.freeze({action:'deduplicated',commandId:c.id,state:s.state});
}
export function cancelWake(input){
 const d=input.dispatcher,id=input.commandId;
 if(!d||typeof d.cancel!=='function')throw new TypeError('dispatcher cancellation required');
 requireId(id,'commandId');
 const r=recordsFor(d);
 if(!r.has(id))return Object.freeze({cancelled:false,reason:'wake-not-owned-by-bridge'});
 const cancelled=d.cancel(id);if(cancelled)r.delete(id);
 return Object.freeze({cancelled:cancelled,reason:cancelled?'cancelled':'job-not-cancellable'});
}
export async function dispatchApprovedWake(input){
 const d=input.dispatcher,id=input.commandId;
 if(!d||typeof d.status!=='function'||typeof d.step!=='function')throw new TypeError('dispatcher required');
 requireId(id,'commandId');
 if(typeof input.verifyApproval!=='function'||input.approval==null)return Object.freeze({state:'rejected',reason:'approval-required'});
 const r=recordsFor(d),record=r.get(id);
 if(!record)return Object.freeze({state:'rejected',reason:'wake-not-owned-by-bridge'});
 const status=d.status(id);if(!status||!['queued','awaiting_approval'].includes(status.state))return Object.freeze({state:'rejected',reason:'job-not-pending'});
 const g=mayDispatch({job:record.job,binding:input.binding,participant:input.participant,approved:true,composerEmpty:input.composerEmpty,foregroundSessionId:input.foregroundSessionId});
 if(!g.ok)return Object.freeze({state:'rejected',reason:g.reason});
 let approved=false;try{approved=(await input.verifyApproval(input.approval,approvalContext(record.command)))===true;}catch{approved=false;}
 if(!approved)return Object.freeze({state:'rejected',reason:'approval-invalid-or-replayed'});
 const outcome=await d.step(id,{approved:true});if(outcome&&TERMINAL.has(outcome.state))r.delete(id);return outcome;
}
