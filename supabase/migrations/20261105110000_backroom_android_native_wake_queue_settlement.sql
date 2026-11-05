-- Reconcile device-authenticated Android wake results with the original durable group lease.
alter table public.backroom_wake_jobs
  add column if not exists native_result_payload jsonb;
alter table public.backroom_wake_jobs
  add column if not exists native_result_at timestamptz;

do $constraints$
begin
  if not exists(select 1 from pg_catalog.pg_constraint
    where conrelid='public.backroom_wake_jobs'::regclass
      and conname='backroom_wake_native_result_payload_bound') then
    alter table public.backroom_wake_jobs
      add constraint backroom_wake_native_result_payload_bound
      check (native_result_payload is null or
        (pg_catalog.jsonb_typeof(native_result_payload)='object'
          and pg_catalog.octet_length(native_result_payload::text)<=8192));
  end if;
  if not exists(select 1 from pg_catalog.pg_constraint
    where conrelid='public.backroom_wake_jobs'::regclass
      and conname='backroom_wake_native_result_time_check') then
    alter table public.backroom_wake_jobs
      add constraint backroom_wake_native_result_time_check
      check ((native_result_payload is null)=(native_result_at is null));
  end if;
end;
$constraints$;

create or replace function public.settle_backroom_android_native_wake_result(
  p_job_id uuid,p_host_id text,p_session_digest text,p_binding_id uuid,
  p_lease_token_digest text,p_handoff_id uuid,p_device_id uuid,p_screen_session_id uuid,
  p_target_id text,p_target_revision integer,p_composer_identity_digest text,
  p_send_control_identity_digest text,p_provider_conversation_identity_digest text,
  p_result_payload jsonb
)
returns text
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_job public.backroom_wake_jobs%rowtype;
  v_binding_active boolean := false;
  v_result_state text;
  v_next_state text;
  v_error_code text;
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
    or p_result_payload is null or pg_catalog.jsonb_typeof(p_result_payload)<>'object'
    or pg_catalog.octet_length(p_result_payload::text)>8192 then
    raise exception 'Invalid native wake result settlement input';
  end if;

  v_result_state:=p_result_payload->>'state';
  if not (p_result_payload ?& array['version','kind','handoffId','jobId','deviceId','roomId','screenSessionId','bindingId','targetId','targetRevision','state','promptInserted','sendInvoked','composerCleared'])
    or p_result_payload->>'version'<>'1'
    or p_result_payload->>'kind'<>'native_wake_result'
    or p_result_payload->>'handoffId'<>p_handoff_id::text
    or p_result_payload->>'jobId'<>p_job_id::text
    or p_result_payload->>'deviceId'<>p_device_id::text
    or p_result_payload->>'screenSessionId'<>p_screen_session_id::text
    or p_result_payload->>'bindingId'<>p_binding_id::text
    or p_result_payload->>'targetId'<>p_target_id
    or p_result_payload->>'targetRevision'<>p_target_revision::text
    or v_result_state not in ('submitted','preflight_denied','needs_review')
    or p_result_payload->>'promptInserted' not in ('true','false')
    or p_result_payload->>'sendInvoked' not in ('true','false')
    or p_result_payload->>'composerCleared' not in ('true','false') then
    raise exception 'Invalid native wake result evidence';
  end if;

  if v_result_state='submitted' then
    if p_result_payload->>'promptInserted'<>'true'
      or p_result_payload->>'sendInvoked'<>'true'
      or p_result_payload->>'composerCleared'<>'true'
      or p_result_payload->>'promptReadbackVerified'<>'true'
      or p_result_payload->>'composerIdentityRevalidated'<>'true'
      or p_result_payload->>'sendControlIdentityRevalidated'<>'true'
      or p_result_payload->>'providerConversationIdentityRevalidated'<>'true'
      or p_result_payload->>'composerIdentityDigest'<>p_composer_identity_digest
      or p_result_payload->>'sendControlIdentityDigest'<>p_send_control_identity_digest
      or p_result_payload->>'providerConversationIdentityDigest'<>p_provider_conversation_identity_digest
      or p_result_payload ? 'reason' then
      raise exception 'Submitted native wake lacks exact composer, Send or provider proof';
    end if;
  elsif v_result_state='preflight_denied' then
    if p_result_payload ?| array['promptReadbackVerified','composerIdentityRevalidated','sendControlIdentityRevalidated','composerIdentityDigest','sendControlIdentityDigest','providerConversationIdentityRevalidated','providerConversationIdentityDigest']
      or p_result_payload->>'promptInserted'<>'false'
      or p_result_payload->>'sendInvoked'<>'false'
      or p_result_payload->>'composerCleared'<>'false'
      or coalesce(p_result_payload->>'reason','')='' then
      raise exception 'Preflight denial cannot claim a side effect';
    end if;
  elsif v_result_state='needs_review' then
    if p_result_payload ?| array['promptReadbackVerified','composerIdentityRevalidated','sendControlIdentityRevalidated','composerIdentityDigest','sendControlIdentityDigest','providerConversationIdentityRevalidated','providerConversationIdentityDigest']
      or coalesce(p_result_payload->>'reason','')=''
      or p_result_payload->>'composerCleared'<>'false'
      or (p_result_payload->>'sendInvoked'='true' and p_result_payload->>'promptInserted'<>'true') then
      raise exception 'Uncertain native wake result must remain terminal review evidence';
    end if;
  end if;

  select * into v_job
  from public.backroom_wake_jobs j
  where j.id=p_job_id and j.host_id=p_host_id
    and j.session_digest=p_session_digest and j.binding_id=p_binding_id
  for update;
  if not found then return 'lease_mismatch'; end if;
  if p_result_payload->>'roomId'<>v_job.room_id::text then
    raise exception 'Native wake result room does not match the durable group job';
  end if;

  -- A device retries after a lost HTTP response; exact evidence is idempotent.
  if v_job.native_result_payload=p_result_payload then
    return 'replayed';
  end if;

  if v_job.state<>'leased' or v_job.lease_owner<>p_host_id
    or v_job.lease_token_hash<>p_lease_token_digest
    or v_job.target_id<>p_target_id or v_job.target_revision<>p_target_revision
    or v_job.provider_conversation_identity_digest<>p_provider_conversation_identity_digest
    or v_job.lease_expires_at<=pg_catalog.clock_timestamp()
    or v_job.expires_at<=pg_catalog.clock_timestamp() then
    return 'lease_mismatch';
  end if;

  select exists(
    select 1 from public.backroom_input_bindings b
    where b.id=p_binding_id and b.owner_id=v_job.owner_id
      and b.room_id=v_job.room_id and b.participant_id=v_job.participant_id
      and b.host_id=v_job.host_id and b.session_digest=v_job.session_digest
      and b.space_id=v_job.space_id and b.session_id=v_job.session_id
      and b.target_id=v_job.target_id
      and b.target_identity_fingerprint=v_job.target_identity_fingerprint
      and b.target_revision=v_job.target_revision
      and b.provider_conversation_identity_digest=p_provider_conversation_identity_digest
      and b.surface='android_app' and b.revoked_at is null
      and b.wake_enabled=true and b.confirmed_at is not null
      and b.wake_expires_at>pg_catalog.clock_timestamp()
  ) into v_binding_active;

  if v_result_state='submitted' then
    v_next_state:=case when v_binding_active then 'acknowledged' else 'cancelled' end;
    v_error_code:=case when v_binding_active then null else 'authorization_denied' end;
  elsif v_result_state='needs_review' then
    v_next_state:='failed';
    v_error_code:='result_unconfirmed';
  elsif not v_binding_active then
    v_next_state:='cancelled';
    v_error_code:='authorization_denied';
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
      updated_at=pg_catalog.clock_timestamp()
  where j.id=p_job_id and j.state='leased'
    and j.lease_owner=p_host_id and j.lease_token_hash=p_lease_token_digest
  returning j.state into v_next_state;

  if not found then return 'lease_mismatch'; end if;
  return v_next_state;
end;
$function$;

revoke all on function public.settle_backroom_android_native_wake_result(
  uuid,text,text,uuid,text,uuid,uuid,uuid,text,integer,text,text,text,jsonb
) from public,anon,authenticated;
grant execute on function public.settle_backroom_android_native_wake_result(
  uuid,text,text,uuid,text,uuid,uuid,uuid,text,integer,text,text,text,jsonb
) to service_role;

comment on column public.backroom_wake_jobs.native_result_payload is
  'Bounded native device result evidence that settles the original group wake lease; excludes prompts and group-message bodies.';
comment on function public.settle_backroom_android_native_wake_result(
  uuid,text,text,uuid,text,uuid,uuid,uuid,text,integer,text,text,text,jsonb
) is
  'Service-role-only Android native wake result settlement. Submitted is acknowledged; proven no-effect preflight is bounded retry; uncertain outcomes are terminal failed/review.';
