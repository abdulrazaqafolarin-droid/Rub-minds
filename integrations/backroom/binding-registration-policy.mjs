/**
 * Pure conflict policy for registering an AI input binding.
 * Caller must authenticate the owner and prove the host, room, participant,
 * agent connection and MCP session before invoking this policy.
 *
 * Never mutates an existing target, never turns consent on, and never reuses a
 * binding after a target identity/fingerprint/revision changes.
 */
const FIELDS=Object.freeze([
 ['owner_id','ownerId'],['room_id','roomId'],['participant_id','participantId'],
 ['host_id','hostId'],['session_digest','sessionDigest'],['space_id','spaceId'],
 ['session_id','sessionId'],['target_id','targetId'],
 ['target_identity_fingerprint','targetIdentityFingerprint'],
 ['target_revision','targetRevision'],['surface','surface'],
 ['locator_kind','locatorKind'],['locator_value','locatorValue'],
 ['provider_conversation_identity_digest','providerConversationIdentityDigest'],
 ['participation_mode','participationMode'],['max_wakes_per_minute','maxWakesPerMinute']
]);
/**
 * @typedef {Record<string, any> & {id:string,owner_id:string,wake_enabled:boolean}} ExistingBackroomBinding
 * @typedef {{ownerId:string,input:Record<string,any>,existingSession?:ExistingBackroomBinding|null,existingTarget?:ExistingBackroomBinding|null}} BindingRegistrationOptions
 * @param {Partial<BindingRegistrationOptions>} [options]
 */
export function classifyExistingBinding({ownerId,input,existingSession=null,existingTarget=null}={}){
 if(!ownerId||!input||typeof input!=='object'||Array.isArray(input))
  throw new TypeError('Authenticated owner and validated binding required');
 if(existingSession&&existingTarget&&existingSession.id!==existingTarget.id)
  return Object.freeze({action:'conflict',reason:'multiple_active_binding_conflict',
   requiresHostRevoke:true,bindingId:null});
 const existing=existingSession??existingTarget;
 if(!existing)return Object.freeze({action:'insert'});
 const matches=FIELDS.every(([column,key])=>{
   const expected=key==='ownerId'?ownerId:input[key];
   if(column==='provider_conversation_identity_digest' && expected===undefined)
    return true; // Device-owned proof is not supplied by the owner/browser enrollment request.
   if(column==='provider_conversation_identity_digest')
    return (existing[column]??null)===(expected??null);
   return existing[column]===expected;
 });
 if(matches&&existing.wake_enabled===false)
  return Object.freeze({action:'reuse',bindingId:existing.id,wakeEnabled:false,
   existing:true,requiresLocalConsent:true});
 return Object.freeze({action:'conflict',
   reason:existing.wake_enabled===true?
    'existing_binding_active_revoke_first':'existing_binding_requires_revoke',
   bindingId:existing.id,wakeEnabled:existing.wake_enabled===true,
   requiresHostRevoke:false});
}
