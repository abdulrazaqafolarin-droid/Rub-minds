import test from 'node:test';
import assert from 'node:assert/strict';
import {bindInput,planWake,planWakeTrigger,mayDispatch,mayDispatchWake,buildCanonicalWakePrompt,isCanonicalWakePrompt,WAKE_PREFIX} from './coordination-core.mjs';
const binding=bindInput({bindingId:'b1',groupId:'g1',participantId:'claude',sessionId:'s1',runtimeId:'android',targetId:'input1',capabilities:['draft'],confirmedAt:1});
const participant={groupId:'g1',participantId:'claude',sessionId:'s1',status:'ready',mode:'mentions',mentions:[]};
const event={id:'e1',groupId:'g1',authorId:'human',type:'mention',targets:['claude']};
const plan=()=>planWake({event,participant,binding});
test('addressed wake queues draft-only prompt requiring approval',()=>{const r=plan();assert.equal(r.action,'queue');assert.equal(r.job.requestedAction,'draft');assert.equal(r.job.requiresApproval,true);assert.ok(r.job.prompt.startsWith(WAKE_PREFIX+'\n'));});
test('cross-group and self-authored events do not wake',()=>{assert.equal(planWake({event:{...event,groupId:'g2'},participant,binding}).action,'skip');assert.equal(planWake({event:{...event,authorId:'claude'},participant,binding}).action,'skip');});
test('duplicates, unrelated mentions and task-mode policy are respected',()=>{assert.equal(planWake({event,participant,binding,alreadyQueued:true}).action,'skip');assert.equal(planWake({event:{...event,targets:['other']},participant,binding}).action,'skip');assert.equal(planWake({event:{...event,type:'message',targets:[]},participant:{...participant,mode:'task'},binding}).action,'skip');});
test('smart mode observes eligible messages without direct mention',()=>{assert.equal(planWake({event:{...event,type:'message',targets:[]},participant:{...participant,mode:'smart'},binding}).action,'queue');});
test('busy, paused, offline, stale, revoked and missing binding defer',()=>{for(const status of ['paused','busy','offline','stale','revoked'])assert.equal(planWake({event,participant:{...participant,status},binding}).action,'defer');assert.equal(planWake({event,participant,binding:null}).action,'defer');});
test('malformed IDs, duplicate capabilities, invalid modes and targets are rejected',()=>{assert.throws(()=>bindInput({...binding,capabilities:['draft','draft']}));assert.throws(()=>bindInput({...binding,targetId:'bad\nvalue'}));assert.throws(()=>planWake({event:{...event,targets:['ok','__proto__\n']},participant,binding}));assert.throws(()=>planWake({event,participant:{...participant,mode:'unrestricted'},binding}));});
test('wake job ID is unambiguous when identifiers contain underscores',()=>{const a=planWake({event:{...event,id:'a_b'},participant,binding}).job.jobId;const b=planWake({event:{...event,id:'a',targets:['b_claude']},participant:{...participant,participantId:'b_claude'},binding:{...binding,participantId:'b_claude'}}).job.jobId;assert.notEqual(a,b);});
test('dispatch requires approval, empty composer, ready session and exact scope',()=>{const input={job:plan().job,binding,participant,approved:true,composerEmpty:true,foregroundSessionId:'s1'};assert.deepEqual(mayDispatch(input),{ok:true,action:'draft-only'});for(const change of [{approved:false},{composerEmpty:false},{foregroundSessionId:'s2'},{binding:{...binding,targetId:'wrong'}},{participant:{...participant,groupId:'g2'}},{participant:{...participant,status:'busy'}},{job:{...plan().job,requestedAction:'submit'}},{job:{...plan().job,prompt:'forged'}}])assert.equal(mayDispatch({...input,...change}).ok,false);});

test('canonical wake trigger requires explicit wake capability and has exact bounded content',()=>{
 const wakeBinding={...binding,capabilities:['draft','wake']};
 const result=planWakeTrigger({event,participant,binding:wakeBinding});
 assert.equal(result.action,'queue');
 assert.equal(result.job.requestedAction,'wake');
 assert.equal(result.job.prompt,buildCanonicalWakePrompt(event.id));
 assert.equal(isCanonicalWakePrompt(result.job.prompt,event.id),true);
 assert.equal(isCanonicalWakePrompt(result.job.prompt+'\nextra',event.id),false);
 assert.equal(isCanonicalWakePrompt('@RMconnects\nEvent: another-event\n'+result.job.prompt.split('\n').slice(2).join('\\n'),event.id),false);
 assert.equal(planWakeTrigger({event,participant,binding}).reason,'wake-capability-not-authorized');
});
test('canonical wake dispatch needs an explicit matching grant, exact focus and wake capability',()=>{
 const wakeBinding={...binding,capabilities:['draft','wake']};
 const wakePlan=planWakeTrigger({event,participant,binding:wakeBinding});
 const job=wakePlan.job;
 const input={job,binding:wakeBinding,participant,authorizationValid:true,composerEmpty:true,foregroundSessionId:participant.sessionId};
 assert.deepEqual(mayDispatchWake(input),{ok:true,action:'canonical-wake-only'});
 for(const change of [{authorizationValid:false},{composerEmpty:false},{foregroundSessionId:'other'},{binding:{...wakeBinding,capabilities:['draft']}},{job:{...job,prompt:job.prompt+'\nforged'}},{job:{...job,requestedAction:'submit'}},{participant:{...participant,status:'paused'}}]){
  assert.equal(mayDispatchWake({...input,...change}).ok,false);
 }
});

test('canonical wake trigger instructs durable pending-reply recovery before exact event delivery',()=>{
 const eventId='550e8400-e29b-41d4-a716-446655440000';
 const prompt=buildCanonicalWakePrompt(eventId);
 assert.match(prompt,/load_original_session_bridge_state/);
 assert.match(prompt,/pending_response/);
 assert.match(prompt,/same source_message_id/);
 assert.match(prompt,/read_group_message/);
 assert.match(prompt,/expected_revision/);
 assert.match(prompt,/revision conflict/);
 assert.match(prompt,/never claim group delivery/);
 assert.equal(isCanonicalWakePrompt(prompt,eventId),true);
 assert.equal(isCanonicalWakePrompt(prompt.replace('source_message_id equal to the Event UUID','source_message_id random'),eventId),false);
});
