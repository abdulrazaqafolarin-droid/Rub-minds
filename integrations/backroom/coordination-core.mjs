/** Pure, fail-closed Backroom coordinator. No automatic send or device access. */
const ID=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const STATUS=new Set(['ready','busy','paused','offline','stale','revoked']);
const MODES=new Set(['mentions','smart','task']);
const EVENTS=new Set(['message','mention','task_assigned','task_updated']);
function valid(x){return typeof x==='string'&&ID.test(x)}
function required(x,k){if(!valid(x))throw new TypeError('Invalid '+k)}
export function bindInput(p){
 for(const k of ['bindingId','groupId','participantId','sessionId','runtimeId','targetId'])required(p[k],k);
 if(!Number.isSafeInteger(p.confirmedAt)||p.confirmedAt<0)throw new TypeError('Invalid timestamp');
 if(!Array.isArray(p.capabilities)||!p.capabilities.includes('draft')||!p.capabilities.every(valid)||new Set(p.capabilities).size!==p.capabilities.length)throw new TypeError('Invalid capabilities');
 return Object.freeze({...p,capabilities:Object.freeze([...p.capabilities])});
}
export function planWake({event,participant:p,binding:b,alreadyQueued=false}){
 if(!event||!p)throw new TypeError('Missing inputs');
 for(const k of ['id','groupId','authorId'])required(event[k],k);
 for(const k of ['groupId','participantId','sessionId'])required(p[k],k);
 if(!EVENTS.has(event.type)||!Array.isArray(event.targets)||!event.targets.every(valid)||!STATUS.has(p.status)||!MODES.has(p.mode)||typeof alreadyQueued!=='boolean')throw new TypeError('Invalid event or policy');
 if(event.groupId!==p.groupId||event.authorId===p.participantId||alreadyQueued)return {action:'skip',reason:'scope-self-or-duplicate'};
 if(p.status!=='ready')return {action:'defer',reason:p.status};
 if(!b||b.groupId!==p.groupId||b.participantId!==p.participantId||b.sessionId!==p.sessionId||!valid(b.targetId)||!b.capabilities?.includes('draft'))return {action:'defer',reason:'binding-unavailable'};
 const addressed=event.targets.includes(p.participantId);
 const eligible=p.mode==='smart'?(addressed||['message','mention','task_assigned'].includes(event.type)):p.mode==='mentions'?addressed:addressed&&['task_assigned','task_updated'].includes(event.type);
 if(!eligible)return {action:'skip',reason:'policy'};
 const job={jobId:event.id+'__'+p.participantId,eventId:event.id,groupId:p.groupId,participantId:p.participantId,sessionId:p.sessionId,bindingId:b.bindingId,targetId:b.targetId,requiresApproval:true,requestedAction:'draft',prompt:'@RMconnects\nEvent: '+event.id+'\nRetrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer. Acknowledge via MCP.'};
 return {action:'queue',job:Object.freeze(job)};
}
export function mayDispatch({job,binding:b,participant:p,approved,composerEmpty,foregroundSessionId}){
 if(!job||!b||!p||!valid(job.jobId))return {ok:false,reason:'missing-input'};
 if(approved!==true)return {ok:false,reason:'approval-required'};
 if(composerEmpty!==true)return {ok:false,reason:'composer-not-empty'};
 if(p.status!=='ready')return {ok:false,reason:'session-not-ready'};
 if(job.groupId!==b.groupId||job.groupId!==p.groupId)return {ok:false,reason:'group-mismatch'};
 if(job.participantId!==p.participantId||b.participantId!==p.participantId||job.sessionId!==p.sessionId||b.sessionId!==p.sessionId||foregroundSessionId!==p.sessionId)return {ok:false,reason:'session-mismatch'};
 if(job.bindingId!==b.bindingId||job.targetId!==b.targetId||!b.capabilities?.includes('draft'))return {ok:false,reason:'target-mismatch'};
 return {ok:true,action:'draft-only'};
}
