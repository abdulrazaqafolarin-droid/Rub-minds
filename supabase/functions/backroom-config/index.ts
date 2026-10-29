/**
 * Owner-authenticated enrollment of a local Backroom host and an INACTIVE
 * selected-input binding. Only a separate consent-proven host activation may
 * enable wake. Requires the draft private queue migration.
 */
import {createClient} from 'npm:@supabase/supabase-js@2';
import {validateHostEnrollment,validatePendingWakeBinding} from '../../../integrations/backroom/host-enrollment-policy.mjs';

const url=Deno.env.get('SUPABASE_URL'),key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if(!url||!key)throw new Error('Backend configuration missing');
const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
const origins=new Set(['https://rub-minds.vercel.app','http://localhost:5173','http://127.0.0.1:5173']);
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
 const header=req.headers.get('authorization')??'';
 const match=/^Bearer ([A-Za-z0-9_.-]{32,4096})$/.exec(header);
 if(!match)return null;
 const {data,error}=await db.auth.getUser(match[1]);
 if(error||!data.user?.id)return null;
 return data.user.id as string;
}
Deno.serve(async req=>{
 const origin=req.headers.get('origin');
 if(origin&&!origins.has(origin))return json(403,{ok:false,reason:'origin_not_allowed'},null);
 if(req.method==='OPTIONS'){
  if(!origin)return json(403,{ok:false},null);
  return new Response(null,{status:204,headers:{
   'Access-Control-Allow-Origin':origin,
   'Access-Control-Allow-Methods':'POST, OPTIONS',
   'Access-Control-Allow-Headers':'Authorization, Content-Type, apikey',
   'Access-Control-Max-Age':'300','Vary':'Origin','Cache-Control':'no-store'
  }});
 }
 const parsed=new URL(req.url);
 if(req.method!=='POST'||parsed.search||parsed.hash||!['/functions/v1/backroom-config/host','/functions/v1/backroom-config/binding','/functions/v1/backroom-config/sessions','/backroom-config/host','/backroom-config/binding','/backroom-config/sessions'].includes(parsed.pathname))
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
   const [participants,connections,sessions]=await Promise.all([
    db.from('participants').select('id,display_name,kind').eq('room_id',value.roomId)
      .in('kind',['original_session','model','external_agent']).limit(100),
    db.from('agent_connections').select('participant_id').eq('room_id',value.roomId)
      .eq('owner_id',ownerId).is('revoked_at',null).gt('expires_at',now).limit(100),
    db.from('rub_minds_mcp_sessions').select('session_digest,participant_id,expires_at')
      .eq('room_id',value.roomId).is('terminated_at',null)
      .not('agent_credential_ciphertext','is',null).gt('expires_at',now).limit(100)
   ]);
   if(participants.error||connections.error||sessions.error)
    return json(503,{ok:false,reason:'service_unavailable'},origin);
   const names=new Map((participants.data??[]).map(p=>[p.id,p.display_name]));
   const joined=new Set((connections.data??[]).map(c=>c.participant_id));
   return json(200,{ok:true,sessions:(sessions.data??[])
    .filter(s=>names.has(s.participant_id)&&joined.has(s.participant_id))
    .slice(0,30).map(s=>({participantId:s.participant_id,
      displayName:names.get(s.participant_id),
      sessionDigest:s.session_digest,expiresAt:s.expires_at}))},origin);
  }
  if(parsed.pathname.endsWith('/host')){
   let input;
   try{input=validateHostEnrollment(value);}catch{return json(400,{ok:false,reason:'invalid_host_registration'},origin);}
   const now=new Date().toISOString();
   const {count,error:countError}=await db.from('backroom_hosts').select('host_id',{count:'exact',head:true})
    .eq('owner_id',ownerId).is('revoked_at',null).gt('expires_at',now);
   if(countError)return json(503,{ok:false,reason:'service_unavailable'},origin);
   if((count??0)>=5)return json(429,{ok:false,reason:'host_limit_reached'},origin);
   const {error}=await db.from('backroom_hosts').insert({
    host_id:input.hostId,owner_id:ownerId,credential_digest:input.credentialDigest,
    expires_at:new Date(Date.now()+input.ttlSeconds*1000).toISOString()
   });
   if(error)return json(409,{ok:false,reason:'registration_conflict'},origin);
   return json(201,{ok:true,hostId:input.hostId,wakeEnabled:false},origin);
  }
  let input;
  try{input=validatePendingWakeBinding(value);}catch{return json(400,{ok:false,reason:'invalid_binding'},origin);}
  const now=new Date().toISOString();
  const [host,room,participant,connection,session]=await Promise.all([
   db.from('backroom_hosts').select('host_id').eq('host_id',input.hostId).eq('owner_id',ownerId)
    .is('revoked_at',null).gt('expires_at',now).maybeSingle(),
   db.from('rooms').select('id').eq('id',input.roomId).eq('owner_id',ownerId).maybeSingle(),
   db.from('participants').select('id').eq('id',input.participantId).eq('room_id',input.roomId)
    .in('kind',['original_session','model','external_agent']).maybeSingle(),
   db.from('agent_connections').select('id').eq('room_id',input.roomId).eq('participant_id',input.participantId)
    .eq('owner_id',ownerId).is('revoked_at',null).gt('expires_at',now).maybeSingle(),
   db.from('rub_minds_mcp_sessions').select('session_digest').eq('session_digest',input.sessionDigest)
    .eq('room_id',input.roomId).eq('participant_id',input.participantId)
    .is('terminated_at',null).not('agent_credential_ciphertext','is',null)
    .gt('expires_at',now).maybeSingle()
  ]);
  if([host,room,participant,connection,session].some(x=>x.error||!x.data))
   return json(403,{ok:false,reason:'binding_not_authorized'},origin);
  const {data,error}=await db.from('backroom_input_bindings').insert({
   owner_id:ownerId,room_id:input.roomId,participant_id:input.participantId,
   host_id:input.hostId,session_digest:input.sessionDigest,
   space_id:input.spaceId,session_id:input.sessionId,target_id:input.targetId,
   target_identity_fingerprint:input.targetIdentityFingerprint,target_revision:input.targetRevision,
   surface:input.surface,locator_kind:input.locatorKind,locator_value:input.locatorValue,
   participation_mode:input.participationMode,max_wakes_per_minute:input.maxWakesPerMinute,
   wake_enabled:false,confirmed_at:null,wake_expires_at:null
  }).select('id').single();
  if(error||!data)return json(409,{ok:false,reason:'binding_conflict'},origin);
  return json(201,{ok:true,bindingId:data.id,wakeEnabled:false,requiresLocalConsent:true},origin);
 }catch{return json(503,{ok:false,reason:'service_unavailable'},origin);}
});
