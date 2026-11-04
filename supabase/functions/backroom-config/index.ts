/**
 * Owner-authenticated enrollment of a local Backroom host and an INACTIVE
 * selected-input binding. Only a separate consent-proven host activation may
 * enable wake. Requires the draft private queue migration.
 */
import {createClient} from 'npm:@supabase/supabase-js@2';
import {validateHostEnrollment,validatePendingWakeBinding,validateNativeTargetProofBinding,validateBindingStatusQuery} from '../../../integrations/backroom/host-enrollment-policy.mjs';
import {classifyExistingBinding} from '../../../integrations/backroom/binding-registration-policy.mjs';
import {resolveOwnerFromJwt} from '../../../integrations/backroom/owner-jwt.mjs';

const url=Deno.env.get('SUPABASE_URL'),key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if(!url||!key)throw new Error('Backend configuration missing');
const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
const origins=new Set(['https://rub-minds.vercel.app','https://rub-minds-fjfauo0n2-abdulrazaqafolarin-droids-projects.vercel.app','https://rub-minds-git-feat-ba-fce441-abdulrazaqafolarin-droids-projects.vercel.app','http://localhost:5173','http://127.0.0.1:5173']);
const MAX_BYTES=8192;
const json=(status:number,payload:unknown,origin:string|null)=>new Response(JSON.stringify(payload),{
 status,headers:{'Content-Type':'application/json','Cache-Control':'no-store',
 'X-Content-Type-Options':'nosniff','Vary':'Origin',
 ...(origin&&origins.has(origin)?{'Access-Control-Allow-Origin':origin}:{})}
});
async function bodyJson(req:Request){
 const reader=req.body?.getReader();
 if(!reader)throw new Error('no-body');
 let bytes=0;const parts=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;
  bytes+=value.byteLength;if(bytes>MAX_BYTES)throw new Error('body-too-large');
  parts.push(value);
 }}finally{reader.releaseLock();}
 const result=new Uint8Array(bytes);let offset=0;
 for(const part of parts){result.set(part,offset);offset+=part.byteLength;}
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(result));
}
async function ownerFromJwt(req:Request){
 return await resolveOwnerFromJwt(req,token=>db.auth.getUser(token));
}
Deno.serve(async req=>{
 const origin=req.headers.get('origin');
 if(origin&&!origins.has(origin))return json(403,{ok:false,reason:'origin_not_allowed'},null);
 if(req.method==='OPTIONS'){
  if(!origin)return json(403,{ok:false},null);
  return new Response(null,{status:204,headers:{
   'Access-Control-Allow-Origin':origin,
   'Access-Control-Allow-Methods':'POST, OPTIONS',
   'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type, x-retry-count, traceparent, tracestate, baggage',
   'Access-Control-Max-Age':'300','Vary':'Origin','Cache-Control':'no-store'
  }});
 }
 const parsed=new URL(req.url);
 if(req.method!=='POST'||parsed.search||parsed.hash||!['/functions/v1/backroom-config/host','/functions/v1/backroom-config/binding','/functions/v1/backroom-config/sessions','/functions/v1/backroom-config/hosts','/functions/v1/backroom-config/binding-status','/functions/v1/backroom-config/revoke-host','/functions/v1/backroom-config/revoke-binding','/backroom-config/host','/backroom-config/binding','/backroom-config/sessions','/backroom-config/hosts','/backroom-config/binding-status','/backroom-config/revoke-host','/backroom-config/revoke-binding','/host','/binding','/sessions','/hosts','/binding-status','/revoke-host','/revoke-binding'].includes(parsed.pathname))
  return json(404,{ok:false,reason:'not_found'},origin);
 if(req.headers.get('content-type')?.toLowerCase()!=='application/json')
  return json(415,{ok:false,reason:'unsupported_type'},origin);
 const declaredLength=req.headers.get('content-length');
 if(declaredLength&&(!/^\d+$/.test(declaredLength)||Number(declaredLength)>MAX_BYTES))
  return json(413,{ok:false,reason:'request_too_large'},origin);
 try{
  const ownerId=await ownerFromJwt(req);
  if(!ownerId)return json(401,{ok:false,reason:'unauthorized'},origin);
  let value;
  try{value=await bodyJson(req);}catch{return json(400,{ok:false,reason:'invalid_body'},origin);}
  if(parsed.pathname.endsWith('/sessions')){
   if(!value||typeof value.roomId!=='string'||!/^[a-f0-9-]{36}$/i.test(value.roomId)||
      Object.keys(value).some(k=>k!=='roomId'))
    return json(400,{ok:false,reason:'invalid_room'},origin);
   const {data:ownedRoom,error:roomError}=await db.from('rooms').select('id')
    .eq('id',value.roomId).eq('owner_id',ownerId).maybeSingle();
   if(roomError||!ownedRoom)return json(403,{ok:false,reason:'not_room_owner'},origin);
   const now=new Date().toISOString();
   const [participants,sessions]=await Promise.all([
    db.from('participants').select('id,display_name,kind,status').eq('room_id',value.roomId)
      .in('kind',['original_session','model','external_agent'])
      .in('status',['connected','active','autonomous']).limit(100),
    db.from('rub_minds_mcp_sessions').select('session_digest,agent_credential_digest,participant_id,expires_at')
      .eq('room_id',value.roomId).is('terminated_at',null)
      .not('agent_credential_ciphertext','is',null).gt('expires_at',now).limit(100)
   ]);
   if(participants.error||sessions.error)
    return json(503,{ok:false,reason:'service_unavailable'},origin);
   const names=new Map((participants.data??[]).map(p=>[p.id,p.display_name]));
   const credentialDigests=[...new Set((sessions.data??[])
    .map(s=>s.agent_credential_digest)
    .filter(digest=>typeof digest==='string'&&/^[a-f0-9]{64}$/.test(digest)))];
   const connections=credentialDigests.length
    ? await db.from('agent_connections').select('credential_digest,expires_at')
       .eq('room_id',value.roomId).eq('owner_id',ownerId)
       .is('revoked_at',null).gt('expires_at',now)
       .in('credential_digest',credentialDigests)
    : {data:[],error:null};
   if(connections.error)
    return json(503,{ok:false,reason:'service_unavailable'},origin);
   const validCredentials=new Map((connections.data??[]).map(c=>[c.credential_digest,c.expires_at]));
   return json(200,{ok:true,sessions:(sessions.data??[])
    .filter(s=>names.has(s.participant_id)&&typeof s.agent_credential_digest==='string'&&validCredentials.has(s.agent_credential_digest))
    .slice(0,30).map(s=>({participantId:s.participant_id,
      displayName:names.get(s.participant_id),
      sessionDigest:s.session_digest,expiresAt:s.expires_at,
      credentialExpiresAt:validCredentials.get(s.agent_credential_digest)}))},origin);
  }
  if(parsed.pathname.endsWith('/hosts')){
   if(!value||typeof value.roomId!=='string'||!/^[a-f0-9-]{36}$/i.test(value.roomId)||
      Object.keys(value).some(k=>k!=='roomId'))
    return json(400,{ok:false,reason:'invalid_room'},origin);
   const {data:room,error:roomError}=await db.from('rooms').select('id')
    .eq('id',value.roomId).eq('owner_id',ownerId).maybeSingle();
   if(roomError)return json(503,{ok:false,reason:'service_unavailable'},origin);
   if(!room)return json(403,{ok:false,reason:'not_room_owner'},origin);
   const now=new Date().toISOString();
   const {data,error}=await db.from('backroom_hosts').select('host_id,expires_at')
    .eq('owner_id',ownerId).is('revoked_at',null).gt('expires_at',now)
    .order('created_at',{ascending:false}).limit(5);
   if(error)return json(503,{ok:false,reason:'service_unavailable'},origin);
   return json(200,{ok:true,hosts:(data??[]).map(row=>({
    hostId:row.host_id,expiresAt:row.expires_at
   }))},origin);
  }
  if(parsed.pathname.endsWith('/binding-status')){
   let input;
   try{input=validateBindingStatusQuery(value);}catch{return json(400,{ok:false,reason:'invalid_binding_status_query'},origin);}
   const {data:ownedRoom,error:roomError}=await db.from('rooms').select('id')
    .eq('id',input.roomId).eq('owner_id',ownerId).maybeSingle();
   if(roomError)return json(503,{ok:false,reason:'service_unavailable'},origin);
   if(!ownedRoom)return json(403,{ok:false,reason:'not_room_owner'},origin);
   let query=db.from('backroom_input_bindings')
    .select('id,participant_id,host_id,session_id,space_id,target_id,target_identity_fingerprint,provider_conversation_identity_digest,target_revision,surface,participation_mode,wake_enabled,wake_expires_at,confirmed_at,revoked_at')
    .eq('owner_id',ownerId).eq('room_id',input.roomId).is('revoked_at',null)
    .order('updated_at',{ascending:false}).limit(10);
   if(input.participantId){
    query=query.eq('participant_id',input.participantId).eq('session_digest',input.sessionDigest);
   }
   const {data,error}=await query;
   if(error)return json(503,{ok:false,reason:'service_unavailable'},origin);
   const now=Date.now();
   const bindings=(data??[]).map(row=>({
    bindingId:row.id,participantId:row.participant_id,hostId:row.host_id,
    sessionId:row.session_id,spaceId:row.space_id,targetId:row.target_id,
    targetIdentityFingerprint:row.target_identity_fingerprint,
    providerConversationIdentityDigest:row.provider_conversation_identity_digest??null,
    targetRevision:row.target_revision,
    surface:row.surface,participationMode:row.participation_mode,
    wakeEnabled:row.wake_enabled===true&&typeof row.wake_expires_at==='string'&&Date.parse(row.wake_expires_at)>now,
    wakeExpiresAt:row.wake_expires_at,confirmedAt:row.confirmed_at
   }));
   return json(200,{ok:true,bindings},origin);
  }
  if(parsed.pathname.endsWith('/revoke-host')){
   if(!value||typeof value.hostId!=='string'||!/^[a-f0-9-]{36}$/i.test(value.hostId)||
      Object.keys(value).some(k=>k!=='hostId'))
    return json(400,{ok:false,reason:'invalid_host'},origin);
   const {data,error}=await db.rpc('revoke_backroom_host',{
    p_host_id:value.hostId,p_owner_id:ownerId
   });
   if(error)return json(503,{ok:false,reason:'service_unavailable'},origin);
   if(data!==true)return json(404,{ok:false,revoked:false,reason:'host_not_found'},origin);
   return json(200,{ok:true,revoked:true,hostId:value.hostId},origin);
  }
  if(parsed.pathname.endsWith('/revoke-binding')){
   if(!value||typeof value.bindingId!=='string'||!/^[a-f0-9-]{36}$/i.test(value.bindingId)||
      Object.keys(value).some(k=>k!=='bindingId'))
    return json(400,{ok:false,reason:'invalid_binding'},origin);
   const {data,error}=await db.rpc('revoke_backroom_input_binding',{
    p_binding_id:value.bindingId,p_owner_id:ownerId
   });
   if(error)return json(503,{ok:false,reason:'service_unavailable'},origin);
   if(data!==true)return json(404,{ok:false,revoked:false,reason:'binding_not_found'},origin);
   return json(200,{ok:true,revoked:true,bindingId:value.bindingId},origin);
  }
  if(parsed.pathname.endsWith('/host')){
   let input;
   try{input=validateHostEnrollment(value);}catch{return json(400,{ok:false,reason:'invalid_host_registration'},origin);}
   const now=new Date().toISOString();
   const expiresAt=new Date(Date.now()+input.ttlSeconds*1000).toISOString();
   const existing=await db.from('backroom_hosts')
    .select('host_id,owner_id,credential_digest,revoked_at')
    .eq('host_id',input.hostId).maybeSingle();
   if(existing.error)return json(503,{ok:false,reason:'service_unavailable'},origin);
   if(existing.data){
    // The stable host ID may renew only with the same owner and credential digest.
    // An owner change, token rotation or explicit revoke must not be silently undone.
    if(existing.data.owner_id!==ownerId||existing.data.credential_digest!==input.credentialDigest||
       existing.data.revoked_at!==null)
     return json(409,{ok:false,reason:'registration_conflict'},origin);
    const {data,error}=await db.from('backroom_hosts').update({expires_at:expiresAt})
     .eq('host_id',input.hostId).eq('owner_id',ownerId)
     .eq('credential_digest',input.credentialDigest).is('revoked_at',null)
     .select('host_id').maybeSingle();
    if(error||!data)return json(409,{ok:false,reason:'registration_conflict'},origin);
    return json(200,{ok:true,hostId:input.hostId,wakeEnabled:false,renewed:true},origin);
   }
   const {count,error:countError}=await db.from('backroom_hosts').select('host_id',{count:'exact',head:true})
    .eq('owner_id',ownerId).is('revoked_at',null).gt('expires_at',now);
   if(countError)return json(503,{ok:false,reason:'service_unavailable'},origin);
   if((count??0)>=5)return json(429,{ok:false,reason:'host_limit_reached'},origin);
   const {error}=await db.from('backroom_hosts').insert({
    host_id:input.hostId,owner_id:ownerId,credential_digest:input.credentialDigest,expires_at:expiresAt
   });
   if(error)return json(409,{ok:false,reason:'registration_conflict'},origin);
   return json(201,{ok:true,hostId:input.hostId,wakeEnabled:false,renewed:false},origin);
  }
  if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.hasOwn(value,'nativeTargetProofId')){
   let proofInput;
   try{proofInput=validateNativeTargetProofBinding(value);}
   catch{return json(400,{ok:false,reason:'invalid_native_target_proof_binding'},origin);}
   const {data:bindingId,error}=await db.rpc('register_backroom_android_native_binding',{
    p_proof_id:proofInput.nativeTargetProofId,
    p_owner_id:ownerId,
    p_room_id:proofInput.roomId,
    p_participant_id:proofInput.participantId,
    p_host_id:proofInput.hostId,
    p_session_digest:proofInput.sessionDigest,
    p_space_id:proofInput.spaceId,
    p_participation_mode:proofInput.participationMode,
    p_max_wakes_per_minute:proofInput.maxWakesPerMinute
   });
   if(error||typeof bindingId!=='string'||!/^[a-f0-9-]{36}$/i.test(bindingId))
    return json(409,{ok:false,reason:'native_target_proof_invalid_expired_or_already_used'},origin);
   return json(201,{ok:true,bindingId,wakeEnabled:false,requiresLocalConsent:true,
    nativeTargetProofConsumed:true},origin);
  }
  let input;
  try{input=validatePendingWakeBinding(value);}catch{return json(400,{ok:false,reason:'invalid_binding'},origin);}
  const now=new Date().toISOString();
  const [host,room,participant,connection,session]=await Promise.all([
   db.from('backroom_hosts').select('host_id').eq('host_id',input.hostId).eq('owner_id',ownerId)
    .is('revoked_at',null).gt('expires_at',now).maybeSingle(),
   db.from('rooms').select('id').eq('id',input.roomId).eq('owner_id',ownerId).maybeSingle(),
   db.from('participants').select('id').eq('id',input.participantId).eq('room_id',input.roomId)
    .in('kind',['original_session','model','external_agent'])
    .in('status',['connected','active','autonomous']).maybeSingle(),
   db.from('agent_connections').select('id').eq('room_id',input.roomId).eq('participant_id',input.participantId)
    .eq('owner_id',ownerId).is('revoked_at',null).gt('expires_at',now).maybeSingle(),
   db.from('rub_minds_mcp_sessions').select('session_digest').eq('session_digest',input.sessionDigest)
    .eq('room_id',input.roomId).eq('participant_id',input.participantId)
    .is('terminated_at',null).not('agent_credential_ciphertext','is',null)
    .gt('expires_at',now).maybeSingle()
  ]);
  if([host,room,participant,connection,session].some(x=>x.error||!x.data))
   return json(403,{ok:false,reason:'binding_not_authorized'},origin);
  const [existingSession,existingTarget]=await Promise.all([
   db.from('backroom_input_bindings')
    .select('id,owner_id,room_id,participant_id,host_id,session_digest,space_id,session_id,target_id,target_identity_fingerprint,provider_conversation_identity_digest,target_revision,surface,locator_kind,locator_value,participation_mode,max_wakes_per_minute,wake_enabled')
    .eq('room_id',input.roomId).eq('participant_id',input.participantId)
    .eq('session_digest',input.sessionDigest).is('revoked_at',null).maybeSingle(),
   db.from('backroom_input_bindings')
    .select('id,owner_id,room_id,participant_id,host_id,session_digest,space_id,session_id,target_id,target_identity_fingerprint,provider_conversation_identity_digest,target_revision,surface,locator_kind,locator_value,participation_mode,max_wakes_per_minute,wake_enabled')
    .eq('host_id',input.hostId).eq('target_id',input.targetId)
    .is('revoked_at',null).maybeSingle()
  ]);
  if(existingSession.error||existingTarget.error)
   return json(503,{ok:false,reason:'service_unavailable'},origin);
  const bindingDecision=classifyExistingBinding({
   ownerId,input,existingSession:existingSession.data,existingTarget:existingTarget.data
  });
  if(bindingDecision.action==='reuse')
   return json(200,{ok:true,bindingId:bindingDecision.bindingId,wakeEnabled:false,
     requiresLocalConsent:true,existing:true},origin);
  if(bindingDecision.action==='conflict')
   return json(409,{ok:false,reason:bindingDecision.reason,
     ...(bindingDecision.bindingId?{bindingId:bindingDecision.bindingId}:{}),
     ...('wakeEnabled' in bindingDecision?{wakeEnabled:bindingDecision.wakeEnabled}:{}),
     ...(bindingDecision.requiresHostRevoke?{requiresHostRevoke:true}:{})},origin);
  const {data,error}=await db.from('backroom_input_bindings').insert({
   owner_id:ownerId,room_id:input.roomId,participant_id:input.participantId,
   host_id:input.hostId,session_digest:input.sessionDigest,
   space_id:input.spaceId,session_id:input.sessionId,target_id:input.targetId,
   target_identity_fingerprint:input.targetIdentityFingerprint,
   ...(input.providerConversationIdentityDigest!==undefined
    ? {provider_conversation_identity_digest:input.providerConversationIdentityDigest} : {}),
   target_revision:input.targetRevision,
   surface:input.surface,locator_kind:input.locatorKind,locator_value:input.locatorValue,
   participation_mode:input.participationMode,max_wakes_per_minute:input.maxWakesPerMinute,
   wake_enabled:false,confirmed_at:null,wake_expires_at:null
  }).select('id').single();
  if(error||!data)return json(409,{ok:false,reason:'binding_conflict'},origin);
  return json(201,{ok:true,bindingId:data.id,wakeEnabled:false,requiresLocalConsent:true},origin);
 }catch{return json(503,{ok:false,reason:'service_unavailable'},origin);}
});
