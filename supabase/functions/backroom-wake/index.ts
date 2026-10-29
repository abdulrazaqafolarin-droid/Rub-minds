/**
 * Trusted Supabase Edge Function entrypoint for host-scoped Backroom wake RPC.
 * Deployment is intentionally separate from the draft PR's code changes.
 * Requires previously provisioned backroom_hosts, backroom_input_bindings,
 * and the private durable queue migration.
 */
import {createClient} from 'npm:@supabase/supabase-js@2';
import {createAuthenticatedWakeGateway} from '../../../integrations/backroom/authenticated-wake-gateway.mjs';
import {createWakeGatewayHttpHandler} from '../../../integrations/backroom/wake-gateway-http.mjs';

const supabaseUrl=Deno.env.get('SUPABASE_URL');
const serviceRoleKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if(!supabaseUrl||!serviceRoleKey)throw new Error('Backroom queue backend configuration missing');
const db=createClient(supabaseUrl,serviceRoleKey,{auth:{persistSession:false,autoRefreshToken:false}});
async function lookupHost(hostId:string) {
 const {data,error}=await db.from('backroom_hosts')
  .select('host_id,owner_id,credential_digest,expires_at,revoked_at')
  .eq('host_id',hostId).maybeSingle();
 if(error||!data)return null;
 return {hostId:data.host_id,ownerId:data.owner_id,credentialDigest:data.credential_digest,
  expiresAt:data.expires_at,revokedAt:data.revoked_at};
}
async function lookupBinding(bindingId:string) {
 const {data,error}=await db.from('backroom_input_bindings')
  .select('id,owner_id,host_id,session_digest,wake_enabled,confirmed_at,wake_expires_at,revoked_at')
  .eq('id',bindingId).maybeSingle();
 if(error||!data)return null;
 return {bindingId:data.id,hostId:data.host_id,ownerId:data.owner_id,sessionDigest:data.session_digest,
  wakeEnabled:data.wake_enabled,confirmedAt:data.confirmed_at,wakeExpiresAt:data.wake_expires_at,
  revokedAt:data.revoked_at};
}
async function rpc(name:string,args:Record<string,unknown>) {
 const {data,error}=await db.rpc(name,args);
 if(error)throw new Error('Backroom private queue unavailable');
 return data;
}
const store={
 async claim({hostId,sessionDigest,bindingId,limit}:{hostId:string,sessionDigest:string,bindingId:string,limit:number}) {
  const rows=await rpc('claim_backroom_wake_jobs',{
   p_host_id:hostId,p_session_digest:sessionDigest,p_binding_id:bindingId,p_limit:limit,p_lease_seconds:30
  });
  if(!Array.isArray(rows)||rows.length>limit)throw new Error('Invalid private queue response');
  return rows.map(row=>{
   if(!row||row.out_binding_id!==bindingId||!row.out_job_id||!row.out_lease_token)
    throw new Error('Invalid private queue lease');
   // Keep only exact server-issued scoped fields; no token or row records from the
   // database are ever accepted from remote clients.
   return {
    jobId:row.out_job_id,jobKey:row.out_job_key,eventId:row.out_event_id,
    ownerId:row.out_owner_id,roomId:row.out_room_id,participantId:row.out_participant_id,
    hostId,sessionDigest,bindingId,
    spaceId:row.out_space_id,sessionId:row.out_session_id,
    targetId:row.out_target_id,targetIdentityFingerprint:row.out_target_identity_fingerprint,
    targetRevision:row.out_target_revision,prompt:row.out_prompt,promptDigest:row.out_prompt_digest,
    attemptCount:row.out_attempt_count,expiresAt:row.out_expires_at,leaseToken:row.out_lease_token
   };
  });
 },
 async acknowledge({hostId,sessionDigest,bindingId,jobId,leaseToken,outcome}:Record<string,string>) {
  return await rpc('ack_backroom_wake_job',{
   p_job_id:jobId,p_host_id:hostId,p_session_digest:sessionDigest,
   p_binding_id:bindingId,p_lease_token:leaseToken,p_outcome:outcome
  });
 },
 async retry({hostId,sessionDigest,bindingId,jobId,leaseToken,retryAfterSeconds,errorCode}:Record<string,unknown>) {
  return await rpc('retry_backroom_wake_job',{
   p_job_id:jobId,p_host_id:hostId,p_session_digest:sessionDigest,p_binding_id:bindingId,
   p_lease_token:leaseToken,p_retry_after_seconds:retryAfterSeconds,p_error_code:errorCode
  });
 }
};
async function activateBinding({hostId,sessionDigest,bindingId,grantId,ttlSeconds}:{
 hostId:string;sessionDigest:string;bindingId:string;grantId:string;ttlSeconds:number
}) {
 const now=new Date();
 const expires=new Date(now.getTime()+ttlSeconds*1000).toISOString();
 const {data,error}=await db.from('backroom_input_bindings')
  .update({wake_enabled:true,wake_grant_id:grantId,wake_last_revoked_grant_id:null,confirmed_at:now.toISOString(),wake_expires_at:expires})
  .eq('id',bindingId).eq('host_id',hostId).eq('session_digest',sessionDigest)
  .is('revoked_at',null)
  .or('wake_enabled.eq.false,wake_grant_id.eq.'+grantId)
  .select('id').maybeSingle();
 if(error)throw new Error('Backroom consent activation unavailable');
 return Boolean(data?.id);
}
async function deactivateBinding({hostId,sessionDigest,bindingId,grantId}:{
 hostId:string;sessionDigest:string;bindingId:string;grantId:string
}) {
 const {data,error}=await db.from('backroom_input_bindings')
  .update({wake_enabled:false,wake_last_revoked_grant_id:grantId,
    wake_grant_id:null,confirmed_at:null,wake_expires_at:null})
  .eq('id',bindingId).eq('host_id',hostId).eq('session_digest',sessionDigest)
  .eq('wake_grant_id',grantId).eq('wake_enabled',true).is('revoked_at',null)
  .select('id').maybeSingle();
 if(error)throw new Error('Backroom consent deactivation unavailable');
 if(data?.id)return true;
 // Idempotent confirmation after a lost success response, but never accept a
 // different grant or a currently active replacement grant.
 const {data:existing,error:readError}=await db.from('backroom_input_bindings')
  .select('wake_enabled,wake_grant_id,wake_last_revoked_grant_id,revoked_at')
  .eq('id',bindingId).eq('host_id',hostId).eq('session_digest',sessionDigest).maybeSingle();
 if(readError)throw new Error('Backroom consent deactivation unavailable');
 return Boolean(existing&&existing.revoked_at===null&&existing.wake_enabled===false&&
  existing.wake_grant_id===null&&existing.wake_last_revoked_grant_id===grantId);
}
const gateway=createAuthenticatedWakeGateway({lookupHost,lookupBinding,store,activateBinding,deactivateBinding});
const handler=createWakeGatewayHttpHandler({gateway});
Deno.serve(req=>handler(req));
