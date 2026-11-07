-- Preserve a distinct terminal reason when a native device reports an
-- exact result after its original group lease has already elapsed.
alter table public.backroom_wake_jobs
  drop constraint if exists backroom_wake_jobs_last_error_code_check;
alter table public.backroom_wake_jobs
  add constraint backroom_wake_jobs_last_error_code_check
  check (last_error_code is null or last_error_code in (
    'target_unavailable','approval_required','provider_busy','transport_error',
    'result_unconfirmed','authorization_denied','max_attempts','other','lease_expired'
  ));

-- Native Android ACK settlement also verifies that the exact attestation is
-- still current. A revoked/replaced screen, app signer, or group mapping cannot
-- acknowledge an old command. Result evidence is still recorded as cancelled
-- so ambiguous post-Send execution is never retried automatically.

revoke all on function public.settle_backroom_android_native_wake_result(uuid,text,text,uuid,text,uuid,uuid,uuid,text,integer,text,text,text,jsonb)
  from public,anon,authenticated,service_role;

create or replace function public.settle_backroom_android_native_wake_result_attested(
  p_job_id uuid,p_host_id text,p_session_digest text,p_binding_id uuid,
  p_lease_token_digest text,p_handoff_id uuid,p_device_id uuid,p_screen_session_id uuid,
  p_app_package_name text,p_app_signing_certificate_sha256 text,
  p_target_id text,p_target_revision integer,p_composer_identity_digest text,
  p_send_control_identity_digest text,p_provider_conversation_identity_digest text,
  p_result_payload jsonb
)
returns text
language plpgsql
security invoker
set search_path=''
as $function$
declare
  v_session public.rub_minds_mcp_sessions%rowtype;
  v_binding public.backroom_input_bindings%rowtype;
  v_native_binding public.backroom_android_native_bindings%rowtype;
  v_native_binding_active boolean := false;
  v_job public.backroom_wake_jobs%rowtype;
  v_binding_active boolean := false;
  v_session_active boolean := false;
  v_lease_expired boolean := false;
  v_result_state text;
  v_next_state text;
  v_error_code text;
  v_prior_receipt jsonb;
begin
  if p_job_id is null
    or p_host_id is null or p_host_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_session_digest is null or p_session_digest !~ '^[0-9a-f]{64}$'
    or p_binding_id is null
    or p_lease_token_digest is null or p_lease_token_digest !~ '^[0-9a-f]{64}$'
    or p_handoff_id is null or p_device_id is null or p_screen_session_id is null
    or p_target_id is null or char_length(btrim(p_target_id)) not between 1 and 128
    or p_target_revision is null or p_target_revision<1
    or p_composer_identity_digest is null or p_composer_identity_digest !~ '^[0-9a-f]{64}$'
    or p_send_control_identity_digest is null or p_send_control_identity_digest !~ '^[0-9a-f]{64}$'
    or p_provider_conversation_identity_digest is null
      or p_provider_conversation_identity_digest !~ '^[0-9a-f]{64}$'
    or p_app_package_name is null
      or p_app_package_name !~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'
    or p_app_signing_certificate_sha256 is null
      or p_app_signing_certificate_sha256 !~ '^[0-9a-f]{64}(\.[0-9a-f]{64})*$'
    or p_result_payload is null or pg_catalog.jsonb_typeof(p_result_payload)<>'object'
    or pg_catalog.octet_length(p_result_payload::text)>8192 then
    raise exception 'Invalid native wake result settlement input';
  end if;

  v_result_state:=p_result_payload->>'state';
  if not (p_result_payload ?& array['version','kind','handoffId','jobId','deviceId','roomId','screenSessionId','bindingId','targetId','targetRevision','state','promptInserted','sendInvoked','composerCleared'])
    or pg_catalog.jsonb_typeof(p_result_payload->'version') is distinct from 'number'
    or pg_catalog.jsonb_typeof(p_result_payload->'targetRevision') is distinct from 'number'
    or pg_catalog.jsonb_typeof(p_result_payload->'kind') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_result_payload->'handoffId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_result_payload->'jobId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_result_payload->'deviceId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_result_payload->'roomId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_result_payload->'screenSessionId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_result_payload->'bindingId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_result_payload->'targetId') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_result_payload->'state') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_result_payload->'promptInserted') is distinct from 'boolean'
    or pg_catalog.jsonb_typeof(p_result_payload->'sendInvoked') is distinct from 'boolean'
    or pg_catalog.jsonb_typeof(p_result_payload->'composerCleared') is distinct from 'boolean'
    or p_result_payload->>'version' is distinct from '1'
    or p_result_payload->>'kind' is distinct from 'native_wake_result'
    or p_result_payload->>'handoffId' is distinct from p_handoff_id::text
    or p_result_payload->>'jobId' is distinct from p_job_id::text
    or p_result_payload->>'deviceId' is distinct from p_device_id::text
    or p_result_payload->>'screenSessionId' is distinct from p_screen_session_id::text
    or p_result_payload->>'bindingId' is distinct from p_binding_id::text
    or p_result_payload->>'targetId' is distinct from p_target_id
    or p_result_payload->>'targetRevision' is distinct from p_target_revision::text
    or v_result_state is null
    or v_result_state not in ('submitted','preflight_denied','needs_review') then
    raise exception 'Invalid native wake result evidence';
  end if;

  if p_result_payload ? 'reason' and pg_catalog.jsonb_typeof(p_result_payload->'reason') is distinct from 'string' then
    raise exception 'Invalid native wake result evidence';
  end if;

  if v_result_state='submitted' then
    if p_result_payload->>'promptInserted' is distinct from 'true'
      or p_result_payload->>'sendInvoked' is distinct from 'true'
      or p_result_payload->>'composerCleared' is distinct from 'true'
      or pg_catalog.jsonb_typeof(p_result_payload->'promptReadbackVerified') is distinct from 'boolean'
      or p_result_payload->>'promptReadbackVerified' is distinct from 'true'
      or pg_catalog.jsonb_typeof(p_result_payload->'composerIdentityRevalidated') is distinct from 'boolean'
      or p_result_payload->>'composerIdentityRevalidated' is distinct from 'true'
      or pg_catalog.jsonb_typeof(p_result_payload->'sendControlIdentityRevalidated') is distinct from 'boolean'
      or p_result_payload->>'sendControlIdentityRevalidated' is distinct from 'true'
      or pg_catalog.jsonb_typeof(p_result_payload->'providerConversationIdentityRevalidated') is distinct from 'boolean'
      or p_result_payload->>'providerConversationIdentityRevalidated' is distinct from 'true'
      or pg_catalog.jsonb_typeof(p_result_payload->'composerIdentityDigest') is distinct from 'string'
      or pg_catalog.jsonb_typeof(p_result_payload->'sendControlIdentityDigest') is distinct from 'string'
      or pg_catalog.jsonb_typeof(p_result_payload->'providerConversationIdentityDigest') is distinct from 'string'
      or p_result_payload->>'composerIdentityDigest' is distinct from p_composer_identity_digest
      or p_result_payload->>'sendControlIdentityDigest' is distinct from p_send_control_identity_digest
      or p_result_payload->>'providerConversationIdentityDigest' is distinct from p_provider_conversation_identity_digest
      or p_result_payload ? 'reason' then
      raise exception 'Submitted native wake lacks exact composer, Send or provider proof';
    end if;
  elsif v_result_state='preflight_denied' then
    if p_result_payload ?| array['promptReadbackVerified','composerIdentityRevalidated','sendControlIdentityRevalidated','composerIdentityDigest','sendControlIdentityDigest','providerConversationIdentityRevalidated','providerConversationIdentityDigest']
      or p_result_payload->>'promptInserted' is distinct from 'false'
      or p_result_payload->>'sendInvoked' is distinct from 'false'
      or p_result_payload->>'composerCleared' is distinct from 'false'
      or coalesce(p_result_payload->>'reason','')='' then
      raise exception 'Preflight denial cannot claim a side effect';
    end if;
  elsif v_result_state='needs_review' then
    if p_result_payload ?| array['promptReadbackVerified','composerIdentityRevalidated','sendControlIdentityRevalidated','composerIdentityDigest','sendControlIdentityDigest','providerConversationIdentityRevalidated','providerConversationIdentityDigest']
      or coalesce(p_result_payload->>'reason','')=''
      or p_result_payload->>'composerCleared' is distinct from 'false'
      or (p_result_payload->>'sendInvoked'='true' and p_result_payload->>'promptInserted' is distinct from 'true') then
      raise exception 'Uncertain native wake result must remain terminal review evidence';
    end if;
  end if;

  -- Serialize against MCP Leave and queue admission using the same lock order:
  -- session advisory lock -> parent MCP session -> input binding -> durable job.
  -- This prevents a concurrent Off/revoke from changing consent between the
  -- settlement check and the job transition.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_session_digest,0)
  );

  select * into v_session
  from public.rub_minds_mcp_sessions s
  where s.session_digest=p_session_digest
  for update;
  if not found then return 'lease_mismatch'; end if;
  v_session_active :=
    v_session.terminated_at is null
    and v_session.expires_at>pg_catalog.clock_timestamp()
    and v_session.agent_credential_ciphertext is not null;

  select * into v_binding
  from public.backroom_input_bindings b
  where b.id=p_binding_id and b.host_id=p_host_id
    and b.session_digest=p_session_digest
  for update;
  if not found then return 'lease_mismatch'; end if;

  -- The device ACK must still map to the exact active Android screen, app signer
  -- and provider conversation that were attested when the command was issued.
  select * into v_native_binding
  from public.backroom_android_native_bindings n
  where n.binding_id=p_binding_id
    and n.owner_id=v_binding.owner_id
    and n.room_id=v_binding.room_id
    and n.participant_id=v_binding.participant_id
    and n.device_id=p_device_id
    and n.screen_session_id=p_screen_session_id
    and n.app_package_name=p_app_package_name
    and n.app_signing_certificate_sha256=p_app_signing_certificate_sha256
    and n.composer_identity_digest=p_composer_identity_digest
    and n.send_control_identity_digest=p_send_control_identity_digest
    and n.provider_conversation_identity_digest=p_provider_conversation_identity_digest
    and n.revoked_at is null
    and n.expires_at>pg_catalog.clock_timestamp()
  for update;
  v_native_binding_active:=found;

  select * into v_job
  from public.backroom_wake_jobs j
  where j.id=p_job_id and j.host_id=p_host_id
    and j.session_digest=p_session_digest and j.binding_id=p_binding_id
  for update;
  if not found then return 'lease_mismatch'; end if;

  if v_session.room_id is distinct from v_job.room_id
    or v_session.participant_id is distinct from v_job.participant_id
    or p_result_payload->>'roomId' is distinct from v_job.room_id::text then
    raise exception 'Native wake result room or MCP session does not match the durable group job';
  end if;

  -- Preserve one bounded result per handoff. A safe preflight retry may
  -- advance the same durable job and replace its latest result, but it must
  -- not erase the receipt needed to acknowledge a delayed duplicate device ACK.
  if v_job.native_result_payload=p_result_payload then
    return case when v_job.state='acknowledged' then 'replayed' else v_job.state end;
  end if;
  select receipt.value into v_prior_receipt
  from pg_catalog.jsonb_array_elements(v_job.native_result_receipts) as receipt(value)
  where receipt.value->>'handoffId'=p_handoff_id::text
  limit 1;
  if found then
    if v_prior_receipt=p_result_payload then
      return case when v_job.state='acknowledged' then 'replayed' else v_job.state end;
    end if;
    raise exception 'Conflicting native wake result for a previously settled handoff';
  end if;

  if v_job.state is distinct from 'leased' or v_job.lease_owner is distinct from p_host_id
    or v_job.lease_token_hash is distinct from p_lease_token_digest
    or v_job.target_id is distinct from p_target_id or v_job.target_revision is distinct from p_target_revision
    or v_job.provider_conversation_identity_digest is distinct from p_provider_conversation_identity_digest then
    return 'lease_mismatch';
  end if;
  -- A device may be offline after a provider action. Preserve its exact saved
  -- receipt even if the original lease has elapsed, but never acknowledge it
  -- as successful outside the lease window. Late submissions become terminal
  -- failed/cancelled evidence for human review.
  v_lease_expired :=
    v_job.lease_expires_at is null
    or v_job.lease_expires_at<=pg_catalog.clock_timestamp()
    or v_job.expires_at<=pg_catalog.clock_timestamp();

  -- The binding row is locked before the job row is changed. A concurrent
  -- grant revocation/rebind must therefore finish first, or wait until this
  -- settlement commits; it cannot slip between consent check and ACK.
  v_binding_active :=
    v_binding.id=p_binding_id
    and v_binding.owner_id=v_job.owner_id
    and v_binding.room_id=v_job.room_id
    and v_binding.participant_id=v_job.participant_id
    and v_binding.host_id=v_job.host_id
    and v_binding.session_digest=v_job.session_digest
    and v_binding.space_id=v_job.space_id
    and v_binding.session_id=v_job.session_id
    and v_binding.target_id=v_job.target_id
    and v_binding.target_identity_fingerprint=v_job.target_identity_fingerprint
    and v_binding.target_revision=v_job.target_revision
    and v_binding.provider_conversation_identity_digest=p_provider_conversation_identity_digest
    and v_binding.surface='android_app'
    and v_binding.revoked_at is null
    and v_binding.wake_enabled is true
    and v_binding.confirmed_at is not null
    and v_binding.wake_expires_at is not null
    and v_binding.wake_expires_at>pg_catalog.clock_timestamp()
    and v_native_binding_active
    and v_session_active;

  if not v_binding_active then
    v_next_state:='cancelled';
    v_error_code:='authorization_denied';
  elsif v_lease_expired then
    v_next_state:='failed';
    v_error_code:='lease_expired';
  elsif v_result_state='submitted' then
    v_next_state:='acknowledged';
    v_error_code:=null;
  elsif v_result_state='needs_review' then
    v_next_state:='failed';
    v_error_code:='result_unconfirmed';
  elsif v_job.attempt_count>=5 then
    v_next_state:='failed';
    v_error_code:='max_attempts';
  else
    -- Only a pre-seal result proving no insertion and no Send may be retried.
    v_next_state:='pending';
    v_error_code:=case when p_result_payload->>'reason'='permission_denied'
      then 'approval_required' else 'target_unavailable' end;
  end if;

  update public.backroom_wake_jobs j
  set state=v_next_state,
      acknowledged_at=case when v_next_state='acknowledged' then pg_catalog.clock_timestamp() else null end,
      available_at=case when v_next_state='pending' then pg_catalog.clock_timestamp()+interval '5 seconds' else j.available_at end,
      lease_owner=null,lease_token_hash=null,lease_expires_at=null,
      last_error_code=v_error_code,
      native_result_payload=p_result_payload,
      native_result_at=pg_catalog.clock_timestamp(),
      native_result_receipts=j.native_result_receipts || pg_catalog.jsonb_build_array(p_result_payload),
      updated_at=pg_catalog.clock_timestamp()
  where j.id=p_job_id and j.state='leased'
    and j.lease_owner=p_host_id and j.lease_token_hash=p_lease_token_digest
  returning j.state into v_next_state;

  if not found then return 'lease_mismatch'; end if;
  return v_next_state;
end;
$function$;



revoke all on function public.settle_backroom_android_native_wake_result_attested(uuid,text,text,uuid,text,uuid,uuid,uuid,text,text,text,integer,text,text,text,jsonb)
  from public,anon,authenticated;
grant execute on function public.settle_backroom_android_native_wake_result_attested(uuid,text,text,uuid,text,uuid,uuid,uuid,text,text,text,integer,text,text,text,jsonb)
  to service_role;

comment on function public.settle_backroom_android_native_wake_result_attested(uuid,text,text,uuid,text,uuid,uuid,uuid,text,text,text,integer,text,text,text,jsonb) is
  'Service-role-only native Android result settlement. Requires the exact still-active group grant and device-attested screen, app signer, composer, Send target, and provider conversation. Revoked mappings retain result evidence as cancelled and are never retried.';

