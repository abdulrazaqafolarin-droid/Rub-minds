-- Atomically forward a claimed Android group wake lease into the enrolled phone's
-- private device-command queue. The browser host never receives the native lease.
--
-- The command row is the short-lived outbox. Its unique job/lease key makes a
-- repeated Edge request idempotent if the first HTTP response was lost.

-- The original registration routine intentionally uses invoker checks, but it
-- SELECTs the room-pair row FOR UPDATE. That table grants service_role SELECT
-- only. Keep the implementation unchanged and expose it through a locked-down
-- SECURITY DEFINER wrapper, instead of granting broad direct UPDATE access.
alter function public.register_backroom_android_native_binding(
  uuid,text,uuid,uuid,text,text,text,text,text
) rename to register_backroom_android_native_binding_impl;

revoke all on function public.register_backroom_android_native_binding_impl(
  uuid,text,uuid,uuid,text,text,text,text,text
) from public,anon,authenticated,service_role;

create function public.register_backroom_android_native_binding(
  p_challenge_id uuid,p_nonce_digest text,p_device_id uuid,p_screen_session_id uuid,
  p_app_package_name text,p_app_signing_certificate_sha256 text,
  p_composer_identity_digest text,p_send_control_identity_digest text,
  p_provider_conversation_identity_digest text
)
returns jsonb
language sql
security definer
set search_path=''
as $function$
  select public.register_backroom_android_native_binding_impl(
    p_challenge_id,p_nonce_digest,p_device_id,p_screen_session_id,
    p_app_package_name,p_app_signing_certificate_sha256,
    p_composer_identity_digest,p_send_control_identity_digest,
    p_provider_conversation_identity_digest
  );
$function$;

revoke all on function public.register_backroom_android_native_binding(
  uuid,text,uuid,uuid,text,text,text,text,text
) from public,anon,authenticated;
grant execute on function public.register_backroom_android_native_binding(
  uuid,text,uuid,uuid,text,text,text,text,text
) to service_role;

comment on function public.register_backroom_android_native_binding(
  uuid,text,uuid,uuid,text,text,text,text,text
) is
  'Service-role-only SECURITY DEFINER wrapper for device-attested Android native binding registration. The invoker implementation remains private and is executed with the locked wrapper owner privileges required for row locks.';
  
create unique index if not exists backroom_android_commands_native_wake_lease_uq
  on public.backroom_android_commands (
    device_id,
    ((command->'nativeWakeHandoff'->>'jobId')),
    ((command->'nativeWakeHandoff'->>'leaseTokenDigest'))
  )
  where command->>'action'='native_wake_trigger';

create or replace function public.queue_backroom_android_native_wake_command(
  p_job_id uuid,
  p_host_id text,
  p_session_digest text,
  p_binding_id uuid,
  p_lease_token text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_now timestamptz:=pg_catalog.clock_timestamp();
  v_mcp public.rub_minds_mcp_sessions%rowtype;
  v_binding public.backroom_input_bindings%rowtype;
  v_candidate public.backroom_android_native_bindings%rowtype;
  v_screen public.backroom_desktop_sessions%rowtype;
  v_device public.backroom_devices%rowtype;
  v_room_binding public.backroom_device_room_bindings%rowtype;
  v_app public.backroom_device_apps%rowtype;
  v_agent public.agent_connections%rowtype;
  v_host public.backroom_hosts%rowtype;
  v_native public.backroom_android_native_bindings%rowtype;
  v_job public.backroom_wake_jobs%rowtype;
  v_handoff_id uuid:=pg_catalog.gen_random_uuid();
  v_request_id uuid:=pg_catalog.gen_random_uuid();
  v_issued_at_ms bigint;
  v_lease_expires_at_ms bigint;
  v_handoff_expires_at timestamptz;
  v_handoff_expires_at_ms bigint;
  v_prompt text;
  v_handoff jsonb;
  v_command jsonb;
  v_command_id uuid;
  v_existing_status text;
begin
  if p_job_id is null
    or p_host_id is null
    or p_host_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or p_session_digest is null or p_session_digest !~ '^[0-9a-f]{64}$'
    or p_binding_id is null
    or p_lease_token is null
    or p_lease_token !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'Invalid Android native wake forward request';
  end if;

  -- Match the registration/settlement lock order. Parent permissions are locked
  -- before their native mapping; the original group job is locked last.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_session_digest,0)
  );

  select * into v_mcp
  from public.rub_minds_mcp_sessions s
  where s.session_digest=p_session_digest
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok',false,'reason','group_session_inactive');
  end if;

  select * into v_binding
  from public.backroom_input_bindings b
  where b.id=p_binding_id and b.host_id=p_host_id
    and b.session_digest=p_session_digest
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok',false,'reason','group_binding_inactive');
  end if;

  if v_binding.surface is distinct from 'android_app'
    or v_binding.revoked_at is not null
    or v_binding.wake_enabled is distinct from true
    or v_binding.confirmed_at is null
    or v_binding.wake_expires_at is null
    or v_binding.provider_conversation_identity_digest is null
    or v_binding.provider_conversation_identity_digest !~ '^[0-9a-f]{64}$'
    or v_mcp.room_id is distinct from v_binding.room_id
    or v_mcp.participant_id is distinct from v_binding.participant_id
    or v_mcp.terminated_at is not null
    or v_mcp.agent_credential_ciphertext is null
    or v_mcp.agent_credential_digest is null
    or v_mcp.agent_credential_digest !~ '^[0-9a-f]{64}$' then
    return pg_catalog.jsonb_build_object('ok',false,'reason','group_binding_inactive');
  end if;

  -- Read the candidate only to discover which mutable parent rows must be
  -- locked next. The exact mapping is re-read under lock below.
  select * into v_candidate
  from public.backroom_android_native_bindings n
  where n.binding_id=v_binding.id
    and n.owner_id=v_binding.owner_id
    and n.room_id=v_binding.room_id
    and n.participant_id=v_binding.participant_id
    and n.provider_conversation_identity_digest=v_binding.provider_conversation_identity_digest
    and n.revoked_at is null
    and n.expires_at>v_now
  order by n.attested_at desc
  limit 1;
  if not found then
    return pg_catalog.jsonb_build_object('ok',false,'reason','native_binding_unavailable');
  end if;

  select * into v_screen
  from public.backroom_desktop_sessions s
  where s.session_id=v_candidate.screen_session_id
    and s.device_id=v_candidate.device_id
    and s.room_id=v_binding.room_id
    and s.requested_by=v_binding.owner_id
    and s.session_type='screen'
    and s.status='active'
    and s.expires_at>v_now
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok',false,'reason','android_screen_inactive');
  end if;

  select * into v_device
  from public.backroom_devices d
  where d.device_id=v_candidate.device_id
    and d.owner_id=v_binding.owner_id
    and d.platform='android'
    and d.status='active'
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok',false,'reason','android_device_inactive');
  end if;

  select * into v_room_binding
  from public.backroom_device_room_bindings rb
  where rb.device_id=v_candidate.device_id
    and rb.room_id=v_binding.room_id
    and rb.owner_id=v_binding.owner_id
    and rb.revoked_at is null
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok',false,'reason','android_room_pairing_inactive');
  end if;

  select * into v_app
  from public.backroom_device_apps a
  where a.device_id=v_candidate.device_id
    and a.package_name=v_candidate.app_package_name
    and a.signing_certificate_sha256=v_candidate.app_signing_certificate_sha256
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok',false,'reason','android_app_signer_unavailable');
  end if;

  select * into v_agent
  from public.agent_connections a
  where a.credential_digest=v_mcp.agent_credential_digest
    and a.owner_id=v_binding.owner_id
    and a.room_id=v_binding.room_id
    and a.participant_id=v_binding.participant_id
    and a.revoked_at is null
    and a.expires_at>v_now
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok',false,'reason','group_credential_inactive');
  end if;

  select * into v_host
  from public.backroom_hosts h
  where h.host_id=v_binding.host_id
    and h.owner_id=v_binding.owner_id
    and h.revoked_at is null
    and h.expires_at>v_now
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok',false,'reason','backroom_host_inactive');
  end if;

  select * into v_native
  from public.backroom_android_native_bindings n
  where n.id=v_candidate.id
    and n.binding_id=v_binding.id
    and n.owner_id=v_binding.owner_id
    and n.room_id=v_binding.room_id
    and n.participant_id=v_binding.participant_id
    and n.device_id=v_candidate.device_id
    and n.screen_session_id=v_screen.session_id
    and n.app_package_name=v_app.package_name
    and n.app_signing_certificate_sha256=v_app.signing_certificate_sha256
    and n.provider_conversation_identity_digest=v_binding.provider_conversation_identity_digest
    and n.revoked_at is null
    and n.expires_at>v_now
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok',false,'reason','native_binding_unavailable');
  end if;

  -- Lock the original group lease last, after the same session/binding locks
  -- used by ACK settlement. A caller-supplied lease token is never trusted
  -- until its digest matches the current server-owned lease row.
  select * into v_job
  from public.backroom_wake_jobs j
  where j.id=p_job_id
    and j.host_id=p_host_id
    and j.session_digest=p_session_digest
    and j.binding_id=p_binding_id
  for update;
  if not found
    or v_job.state is distinct from 'leased'
    or v_job.lease_owner is distinct from p_host_id
    or v_job.lease_token_hash is distinct from
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_lease_token,'UTF8')),'hex') then
    return pg_catalog.jsonb_build_object('ok',false,'reason','group_lease_mismatch');
  end if;

  v_now:=pg_catalog.clock_timestamp();
  if v_job.lease_expires_at is null or v_job.lease_expires_at<=v_now
    or v_job.expires_at<=v_now
    or v_binding.wake_expires_at<=v_now
    or v_mcp.expires_at<=v_now
    or v_screen.status is distinct from 'active' or v_screen.expires_at<=v_now
    or v_device.status is distinct from 'active'
    or v_agent.revoked_at is not null or v_agent.expires_at<=v_now
    or v_host.revoked_at is not null or v_host.expires_at<=v_now
    or v_native.revoked_at is not null or v_native.expires_at<=v_now
    or v_binding.owner_id is distinct from v_job.owner_id
    or v_binding.room_id is distinct from v_job.room_id
    or v_binding.participant_id is distinct from v_job.participant_id
    or v_binding.space_id is distinct from v_job.space_id
    or v_binding.session_id is distinct from v_job.session_id
    or v_binding.target_id is distinct from v_job.target_id
    or v_binding.target_identity_fingerprint is distinct from v_job.target_identity_fingerprint
    or v_binding.target_revision is distinct from v_job.target_revision
    or v_binding.provider_conversation_identity_digest is distinct from v_job.provider_conversation_identity_digest
    or v_native.provider_conversation_identity_digest is distinct from v_job.provider_conversation_identity_digest
    or v_native.composer_identity_digest !~ '^[0-9a-f]{64}$'
    or v_native.send_control_identity_digest !~ '^[0-9a-f]{64}$'
    or not exists (
      select 1 from public.rooms r
      where r.id=v_job.room_id and r.owner_id=v_job.owner_id
    )
    or not exists (
      select 1 from public.participants p
      where p.id=v_job.participant_id and p.room_id=v_job.room_id
        and p.kind in ('original_session','model','external_agent')
        and p.status in ('connected','active','autonomous')
    ) then
    return pg_catalog.jsonb_build_object('ok',false,'reason','native_wake_scope_inactive');
  end if;

  v_prompt:='@RMconnects'||pg_catalog.chr(10)||
    'Event: '||v_job.event_id||pg_catalog.chr(10)||
    'Retrieve authorized pending events through Rub Minds MCP. Observe, reply, or defer according to your group policy. Acknowledge via MCP.';
  if v_job.prompt is distinct from v_prompt
    or v_job.prompt_digest is distinct from
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_prompt,'UTF8')),'hex') then
    return pg_catalog.jsonb_build_object('ok',false,'reason','canonical_wake_prompt_mismatch');
  end if;

  v_handoff_expires_at:=least(
    v_job.lease_expires_at,
    v_job.expires_at,
    v_binding.wake_expires_at,
    v_mcp.expires_at,
    v_screen.expires_at,
    v_agent.expires_at,
    v_host.expires_at,
    v_native.expires_at,
    v_now+interval '20 seconds'
  );
  if v_handoff_expires_at<=v_now+interval '250 milliseconds' then
    return pg_catalog.jsonb_build_object('ok',false,'reason','native_wake_lease_too_close_to_expiry');
  end if;

  v_issued_at_ms:=floor(extract(epoch from v_now)*1000)::bigint;
  v_lease_expires_at_ms:=floor(extract(epoch from v_job.lease_expires_at)*1000)::bigint;
  v_handoff_expires_at_ms:=floor(extract(epoch from v_handoff_expires_at)*1000)::bigint;

  v_handoff:=pg_catalog.jsonb_build_object(
    'version',1,
    'kind','native_wake_trigger',
    'handoffId',v_handoff_id::text,
    'jobId',v_job.id::text,
    'eventId',v_job.event_id,
    'deviceId',v_native.device_id::text,
    'roomId',v_job.room_id::text,
    'screenSessionId',v_native.screen_session_id::text,
    'hostId',v_job.host_id,
    'bindingId',v_binding.id::text,
    'sessionDigest',v_job.session_digest,
    'sessionId',v_job.session_id,
    'targetId',v_job.target_id,
    'targetRevision',v_job.target_revision,
    'surface','android_app',
    'appId',v_native.app_package_name,
    'identityFingerprint',v_native.app_signing_certificate_sha256,
    'composerIdentityDigest',v_native.composer_identity_digest,
    'sendControlIdentityDigest',v_native.send_control_identity_digest,
    'providerConversationIdentityDigest',v_native.provider_conversation_identity_digest,
    'leaseTokenDigest',v_job.lease_token_hash,
    'prompt',v_prompt,
    'promptDigest',v_job.prompt_digest,
    'issuedAt',v_issued_at_ms,
    'leaseExpiresAt',v_lease_expires_at_ms,
    'expiresAt',v_handoff_expires_at_ms
  );

  v_command:=pg_catalog.jsonb_build_object(
    'action','native_wake_trigger',
    'deviceId',v_native.device_id::text,
    'roomId',v_job.room_id::text,
    'requestId',v_request_id::text,
    'issuedAt',v_issued_at_ms,
    'sessionId',v_native.screen_session_id::text,
    'appPackageName',v_native.app_package_name,
    'nativeWakeHandoff',v_handoff
  );

  insert into public.backroom_android_commands(
    device_id,room_id,session_id,request_id,command,status,expires_at
  ) values (
    v_native.device_id,v_job.room_id,v_native.screen_session_id,
    v_request_id,v_command,'pending',v_job.lease_expires_at
  )
  on conflict do nothing
  returning id into v_command_id;

  if v_command_id is not null then
    return pg_catalog.jsonb_build_object('ok',true,'state','queued');
  end if;

  -- The same request may be retried after a lost Edge response. Return success
  -- only when the existing command belongs to this exact device/job/lease.
  select c.id,c.status into v_command_id,v_existing_status
  from public.backroom_android_commands c
  where c.device_id=v_native.device_id
    and c.room_id=v_job.room_id
    and c.session_id=v_native.screen_session_id
    and c.command->>'action'='native_wake_trigger'
    and c.command->'nativeWakeHandoff'->>'jobId'=v_job.id::text
    and c.command->'nativeWakeHandoff'->>'leaseTokenDigest'=v_job.lease_token_hash
  limit 1;

  if not found then
    raise exception 'Android native wake command idempotency conflict';
  end if;
  return pg_catalog.jsonb_build_object('ok',true,'state','already_queued');
end;
$function$;

revoke all on function public.queue_backroom_android_native_wake_command(uuid,text,text,uuid,text)
  from public,anon,authenticated;
grant execute on function public.queue_backroom_android_native_wake_command(uuid,text,text,uuid,text)
  to service_role;

comment on function public.queue_backroom_android_native_wake_command(uuid,text,text,uuid,text) is
  'Service-role-only atomic Android group-to-device forwarder. Checks the exact live lease, MCP/group binding, consent, host, phone pair, screen, app signer and current device attestation before queuing a canonical event-only handoff. Repeated requests for the same device/job/lease are idempotent.';
