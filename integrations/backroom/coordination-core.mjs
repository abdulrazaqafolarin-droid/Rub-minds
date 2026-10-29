/** Backroom coordinator v1: pure, fail-closed event-to-wake planning.
 * No OS control, MCP authority, networking, persistence, or automatic Send.
 */
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const STATES = new Set(['ready','busy','paused','offline','stale','revoked']);
const MODES = new Set(['mentions','smart','task']);
const EVENTS = new Set(['message','mention','task_assigned','task_updated']);
export const WAKE_PREFIX = '@RMconnects';
const WAKE_INSTRUCTIONS = 'Retrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer according to your group policy. Acknowledge via MCP.';
export function buildCanonicalWakePrompt(eventId) {
  needId(eventId, 'eventId');
  return WAKE_PREFIX + '\nEvent: ' + eventId + '\n' + WAKE_INSTRUCTIONS;
}
export function isCanonicalWakePrompt(prompt, eventId) {
  return validId(eventId) && typeof prompt === 'string' && prompt === buildCanonicalWakePrompt(eventId);
}
export function validId(value) { return typeof value === 'string' && ID.test(value); }
function needId(value,name) { if (!validId(value)) throw new TypeError('Invalid ' + name); return value; }
function needTime(value) { if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid timestamp'); return value; }
export function bindInput(input) {
  const keys=['bindingId','groupId','participantId','sessionId','runtimeId','targetId'];
  for (const key of keys) needId(input[key],key);
  needTime(input.confirmedAt);
  const capabilities=input.capabilities;
  if (!Array.isArray(capabilities) || !capabilities.includes('draft') || !capabilities.every(validId) ||
      new Set(capabilities).size !== capabilities.length) throw new TypeError('Invalid capabilities');
  return Object.freeze({bindingId:input.bindingId,groupId:input.groupId,participantId:input.participantId,
    sessionId:input.sessionId,runtimeId:input.runtimeId,targetId:input.targetId,
    capabilities:Object.freeze([...capabilities]),confirmedAt:input.confirmedAt});
}
export function normalizeParticipant(participant) {
  if (!participant || typeof participant !== 'object' || Array.isArray(participant)) throw new TypeError('Invalid participant');
  for (const key of ['groupId','participantId','sessionId']) needId(participant[key],key);
  if (!STATES.has(participant.status) || !MODES.has(participant.mode)) throw new TypeError('Invalid participant state');
  if (!Array.isArray(participant.mentions) || !participant.mentions.every(validId)) throw new TypeError('Invalid mentions');
  return {...participant,mentions:[...participant.mentions]};
}
function eligibleForMode(event,participant,addressed) {
  if (participant.mode === 'mentions') return addressed;
  if (participant.mode === 'task') return addressed && ['task_assigned','task_updated'].includes(event.type);
  return addressed || ['message','mention','task_assigned'].includes(event.type);
}
export function planWake(input) {
  const event=input.event;
  const p=normalizeParticipant(input.participant);
  const binding=input.binding;
  const alreadyQueued=input.alreadyQueued === undefined ? false : input.alreadyQueued;
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new TypeError('Invalid event');
  for (const key of ['id','groupId','authorId']) needId(event[key],key);
  if (!EVENTS.has(event.type) || !Array.isArray(event.targets) || !event.targets.every(validId) ||
      typeof alreadyQueued !== 'boolean') throw new TypeError('Invalid event type, targets, or queue flag');
  if (event.groupId !== p.groupId || event.authorId === p.participantId || alreadyQueued) {
    return {action:'skip',reason:'scope-self-or-duplicate'};
  }
  if (p.status !== 'ready') return {action:'defer',reason:p.status};
  if (!binding || binding.groupId !== p.groupId || binding.participantId !== p.participantId ||
      binding.sessionId !== p.sessionId || !validId(binding.bindingId) || !validId(binding.targetId) ||
      !Array.isArray(binding.capabilities) || !binding.capabilities.includes('draft')) {
    return {action:'defer',reason:'binding-unavailable'};
  }
  const addressed=event.targets.includes(p.participantId);
  if (!eligibleForMode(event,p,addressed)) return {action:'skip',reason:'policy'};
  const jobId='wake_'+event.id.length+'_'+event.id+'_'+p.participantId.length+'_'+p.participantId;
  const job=Object.freeze({
    jobId:jobId,eventId:event.id,groupId:p.groupId,participantId:p.participantId,sessionId:p.sessionId,
    bindingId:binding.bindingId,targetId:binding.targetId,requiresApproval:true,requestedAction:'draft',
    prompt:WAKE_PREFIX+'\nEvent: '+event.id+'\nRetrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer according to your group policy. Acknowledge via MCP.'
  });
  return {action:'queue',job:job};
}
/** A stricter durable trigger plan. It never carries arbitrary group-message text. */
export function planWakeTrigger(input) {
  const decision = planWake(input);
  if (decision.action !== 'queue') return decision;
  if (!Array.isArray(input.binding?.capabilities) || !input.binding.capabilities.includes('wake')) {
    return { action:'defer', reason:'wake-capability-not-authorized' };
  }
  return {
    ...decision,
    job: Object.freeze({ ...decision.job, requestedAction: 'wake', prompt: buildCanonicalWakePrompt(decision.job.eventId) }),
  };
}
export function mayDispatchWake(input) {
  const job=input.job,b=input.binding,p=input.participant;
  if (!job || !b || !p || !validId(job.eventId)) return {ok:false,reason:'missing-input'};
  if (job.requiresApproval !== true || job.requestedAction !== 'wake' ||
      !isCanonicalWakePrompt(job.prompt,job.eventId)) return {ok:false,reason:'invalid-wake-trigger'};
  if (input.authorizationValid !== true) return {ok:false,reason:'wake-authorization-required'};
  if (input.composerEmpty !== true) return {ok:false,reason:'composer-not-empty'};
  if (p.status !== 'ready') return {ok:false,reason:'session-not-ready'};
  if (job.groupId !== b.groupId || job.groupId !== p.groupId) return {ok:false,reason:'group-mismatch'};
  if (job.participantId !== p.participantId || b.participantId !== job.participantId ||
      job.sessionId !== p.sessionId || b.sessionId !== job.sessionId ||
      input.foregroundSessionId !== job.sessionId) return {ok:false,reason:'session-mismatch'};
  if (job.bindingId !== b.bindingId || job.targetId !== b.targetId ||
      !Array.isArray(b.capabilities) || !b.capabilities.includes('wake')) return {ok:false,reason:'target-mismatch'};
  return {ok:true,action:'canonical-wake-only'};
}
export function mayDispatch(input) {
  const job=input.job,b=input.binding,p=input.participant;
  if (!job || !b || !p || !validId(job.jobId)) return {ok:false,reason:'missing-input'};
  if (job.requiresApproval !== true || job.requestedAction !== 'draft' ||
      typeof job.prompt !== 'string' || !job.prompt.startsWith(WAKE_PREFIX+'\n')) return {ok:false,reason:'invalid-wake-job'};
  if (input.approved !== true) return {ok:false,reason:'approval-required'};
  if (input.composerEmpty !== true) return {ok:false,reason:'composer-not-empty'};
  if (p.status !== 'ready') return {ok:false,reason:'session-not-ready'};
  if (job.groupId !== b.groupId || job.groupId !== p.groupId) return {ok:false,reason:'group-mismatch'};
  if (job.participantId !== p.participantId || b.participantId !== job.participantId ||
      job.sessionId !== p.sessionId || b.sessionId !== job.sessionId ||
      input.foregroundSessionId !== job.sessionId) return {ok:false,reason:'session-mismatch'};
  if (job.bindingId !== b.bindingId || job.targetId !== b.targetId ||
      !Array.isArray(b.capabilities) || !b.capabilities.includes('draft')) return {ok:false,reason:'target-mismatch'};
  return {ok:true,action:'draft-only'};
}
