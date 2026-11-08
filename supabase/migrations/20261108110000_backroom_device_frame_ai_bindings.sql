-- Host-independent association between an existing joined AI session and a
-- selected app/runtime inside a trusted Backroom device frame.
--
-- The AI's existing MCP session remains the group participant. This migration
-- does not create another participant or message/task/memory store, and does
-- not replace or weaken the legacy host-scoped durable wake queue.

create table if not exists public.backroom_frame_ai_binding_challenges (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  mcp_session_digest text not null
    references public.rub_minds_mcp_sessions(session_digest) on delete cascade,
  agent_credential_digest text not null check (agent_credential_digest ~ '^[0-9a-f]{64}$'),
  device_id uuid not null references public.backroom_devices(device_id) on delete cascade,
  runtime_session_id uuid not null references public.backroom_desktop_sessions(session_id) on delete cascade,
  surface text not null check (surface in ('android_app','desktop_app','windows_app','terminal')),
  app_id text not null,
  app_identity_fingerprint text not null,
  nonce_digest text not null unique check (nonce_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  constraint backroom_frame_ai_challenge_expiry_check check (expires_at > created_at),
  constraint backroom_frame_ai_challenge_terminal_state_check check (
    not (consumed_at is not null and revoked_at is not null)
  ),
  constraint backroom_frame_ai_challenge_app_identity_check check (
    (surface='android_app'
      and app_id ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'
      and app_identity_fingerprint ~ '^[0-9a-f]{64}(\.[0-9a-f]{64})*$')
    or
    (surface in ('desktop_app','windows_app','terminal')
      and app_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and app_identity_fingerprint ~ '^[0-9a-f]{64}$')
  )
);
alter table public.backroom_frame_ai_binding_challenges enable row level security;
revoke all on table public.backroom_frame_ai_binding_challenges from public,anon,authenticated;
grant select,insert,update,delete on table public.backroom_frame_ai_binding_challenges to service_role;
create index if not exists backroom_frame_ai_binding_challenges_pending_idx
  on public.backroom_frame_ai_binding_challenges(device_id,runtime_session_id,expires_at)
  where consumed_at is null and revoked_at is null;
create index if not exists backroom_frame_ai_binding_challenges_mcp_idx
  on public.backroom_frame_ai_binding_challenges(mcp_session_digest,created_at desc);

create table if not exists public.backroom_frame_ai_bindings (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  challenge_id uuid not null unique
    references public.backroom_frame_ai_binding_challenges(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  mcp_session_digest text not null
    references public.rub_minds_mcp_sessions(session_digest) on delete cascade,
  agent_credential_digest text not null check (agent_credential_digest ~ '^[0-9a-f]{64}$'),
  device_id uuid not null references public.backroom_devices(device_id) on delete cascade,
  runtime_session_id uuid not null references public.backroom_desktop_sessions(session_id) on delete cascade,
  surface text not null check (surface in ('android_app','desktop_app','windows_app','terminal')),
  app_id text not null,
  app_identity_fingerprint text not null,
  runtime_identity_digest text not null check (runtime_identity_digest ~ '^[0-9a-f]{64}$'),
  composer_identity_digest text check (
    composer_identity_digest is null or composer_identity_digest ~ '^[0-9a-f]{64}$'
  ),
  send_control_identity_digest text check (
    send_control_identity_digest is null or send_control_identity_digest ~ '^[0-9a-f]{64}$'
  ),
  provider_conversation_identity_digest text check (
    provider_conversation_identity_digest is null
    or provider_conversation_identity_digest ~ '^[0-9a-f]{64}$'
  ),
  wake_enabled boolean not null default false,
  wake_expires_at timestamptz,
  attested_at timestamptz not null default pg_catalog.clock_timestamp(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  constraint backroom_frame_ai_binding_expiry_check check (expires_at > attested_at),
  constraint backroom_frame_ai_binding_terminal_capability_check check (
    not (surface='terminal' and (
      composer_identity_digest is not null
      or send_control_identity_digest is not null
      or provider_conversation_identity_digest is not null
      or wake_enabled
    ))
  ),
  constraint backroom_frame_ai_binding_wake_consent_check check (
    not wake_enabled or (
      surface <> 'terminal'
      and composer_identity_digest is not null
      and send_control_identity_digest is not null
      and provider_conversation_identity_digest is not null
      and wake_expires_at is not null
      and wake_expires_at <= expires_at
    )
  ),
  constraint backroom_frame_ai_binding_app_identity_check check (
    (surface='android_app'
      and app_id ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'
      and app_identity_fingerprint ~ '^[0-9a-f]{64}(\.[0-9a-f]{64})*$')
    or
    (surface in ('desktop_app','windows_app','terminal')
      and app_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and app_identity_fingerprint ~ '^[0-9a-f]{64}$')
  )
);
alter table public.backroom_frame_ai_bindings enable row level security;
revoke all on table public.backroom_frame_ai_bindings from public,anon,authenticated;
grant select,insert,update,delete on table public.backroom_frame_ai_bindings to service_role;
create unique index if not exists backroom_frame_ai_bindings_active_mcp_session_uq
  on public.backroom_frame_ai_bindings(mcp_session_digest) where revoked_at is null;
create unique index if not exists backroom_frame_ai_bindings_active_runtime_uq
  on public.backroom_frame_ai_bindings(device_id,runtime_session_id) where revoked_at is null;
create index if not exists backroom_frame_ai_bindings_room_idx
  on public.backroom_frame_ai_bindings(room_id,attested_at desc) where revoked_at is null;
create index if not exists backroom_frame_ai_bindings_expiry_idx
  on public.backroom_frame_ai_bindings(expires_at) where revoked_at is null;

-- The caller is the authenticated group owner. The trusted Edge Function
-- supplies only IDs from the existing AI session and approved device. This
-- routine independently verifies every relationship before issuing a nonce.
create or replace function public.create_backroom_frame_ai_binding_challenge(
  p_challenge_id uuid,
  p_nonce_digest text,
  p_owner_id uuid,
  p_room_id uuid,
  p_participant_id uuid,
  p_session_digest text,
  p_device_id uuid,
  p_runtime_session_id uuid,
  p_surface text,
  p_app_id text
) returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_now timestamptz:=pg_catalog.clock_timestamp();
  v_room public.rooms%rowtype;
  v_mcp public.rub_minds_mcp_sessions%rowtype;
  v_participant public.participants%rowtype;
  v_device public.backroom_devices%rowtype;
  v_room_binding public.backroom_device_room_bindings%rowtype;
  v_runtime public.backroom_desktop_sessions%rowtype;
  v_agent public.agent_connections%rowtype;
  v_android_app public.backroom_device_apps%rowtype;
  v_desktop_app public.backroom_desktop_apps%rowtype;
  v_fingerprint text;
  v_expected_session_type text;
  v_expires_at timestamptz;
begin
  if p_challenge_id is null or p_owner_id is null or p_room_id is null
    or p_participant_id is null or p_device_id is null or p_runtime_session_id is null
    or p_session_digest is null or p_session_digest !~ '^[0-9a-f]{64}$'
    or p_nonce_digest is null or p_nonce_digest !~ '^[0-9a-f]{64}$'
    or p_surface is null
    or p_surface not in ('android_app','desktop_app','windows_app','terminal')
    or p_app_id is null then
    return pg_catalog.jsonb_build_object('ok',false,'reason','invalid_binding_challenge');
  end if;

  if p_surface='android_app' then
    if p_app_id !~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$' then
      return pg_catalog.jsonb_build_object('ok',false,'reason','invalid_app_id');
    end if;
    v_expected_session_type:='screen';
  else
    if p_app_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      return pg_catalog.jsonb_build_object('ok',false,'reason','invalid_app_id');
    end if;
    v_expected_session_type:=case when p_surface='terminal' then 'terminal' else 'screen' end;
  end if;

  -- One binding/challenge operation at a time for the same MCP session.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_session_digest,0));

  select r.* into v_room
  from public.rooms r
  where r.id=p_room_id and r.owner_id=p_owner_id;
  if not found then
    return pg_catalog.jsonb_build_object('ok',false,'reason','room_owner_required');
  end if;

  select s.* into v_mcp
  from public.rub_minds_mcp_sessions s
  where s.session_digest=p_session_digest
  for update;
  if not found or v_mcp.room_id is distinct from p_room_id
    or v_mcp.participant_id is distinct from p_participant_id
    or v_mcp.terminated_at is not null or v_mcp.expires_at<=v_now
    or v_mcp.agent_credential_ciphertext is null
    or v_mcp.agent_credential_digest is null
    or v_mcp.agent_credential_digest !~ '^[0-9a-f]{64}$' then
    return pg_catalog.jsonb_build_object('ok',false,'reason','group_ai_session_inactive');
  end if;

  select p.* into v_participant
  from public.participants p
  where p.id=p_participant_id and p.room_id=p_room_id
    and p.kind in ('original_session','model','external_agent')
    and p.status in ('connected','active','autonomous')
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok',false,'reason','ai_participant_inactive');
  end if;

  select d.* into v_device
  from public.backroom_devices d
  where d.device_id=p_device_id and d.owner_id=p_owner_id and d.status='active'
    and d.revoked_at is null
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok',false,'reason','device_not_active');
  end if;
  if (p_surface='android_app' and v_device.platform<>'android')
    or (p_surface='windows_app' and v_device.platform<>'windows')
    or (p_surface in ('desktop_app','terminal') and v_device.platform not in ('windows','macos','linux')) then
    return pg_catalog.jsonb_build_object('ok',false,'reason','device_platform_mismatch');
  end if;

  select rb.* into v_room_binding
  from public.backroom_device_room_bindings rb
  where rb.device_id=p_device_id and rb.room_id=p_room_id
    and rb.owner_id=p_owner_id and rb.revoked_at is null
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok',false,'reason','device_room_binding_inactive');
  end if;

  select s.* into v_runtime
  from public.backroom_desktop_sessions s
  where s.session_id=p_runtime_session_id and s.device_id=p_device_id
    and s.room_id=p_room_id and s.requested_by=p_owner_id
    and s.session_type=v_expected_session_type
    and s.status='active' and s.expires_at>v_now
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok',false,'reason','runtime_session_inactive');
  end if;

  select a.* into v_agent
  from public.agent_connections a
  where a.credential_digest=v_mcp.agent_credential_digest
    and a.owner_id=p_owner_id and a.room_id=p_room_id
    and a.participant_id=p_participant_id
    and a.revoked_at is null and a.expires_at>v_now
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok',false,'reason','group_ai_credential_inactive');
  end if;

  if p_surface='android_app' then
    select a.* into v_android_app
    from public.backroom_device_apps a
    where a.device_id=p_device_id and a.package_name=p_app_id
    for update;
    if not found then
      return pg_catalog.jsonb_build_object('ok',false,'reason','app_not_selected_on_device');
    end if;
    v_fingerprint:=v_android_app.signing_certificate_sha256;
  else
    select a.* into v_desktop_app
    from public.backroom_desktop_apps a
    where a.device_id=p_device_id and a.app_id=p_app_id::uuid
    for update;
    if not found then
      return pg_catalog.jsonb_build_object('ok',false,'reason','app_not_selected_on_device');
    end if;
    v_fingerprint:=v_desktop_app.executable_sha256;
  end if;

  -- Reclaim expired rows before checking the partial unique active indexes.
  update public.backroom_frame_ai_bindings b
  set revoked_at=v_now,wake_enabled=false,wake_expires_at=null
  where b.revoked_at is null and b.expires_at<=v_now
    and (b.mcp_session_digest=p_session_digest
      or (b.device_id=p_device_id and b.runtime_session_id=p_runtime_session_id));

  if exists(select 1 from public.backroom_frame_ai_bindings b
      where b.mcp_session_digest=p_session_digest and b.revoked_at is null)
    or exists(select 1 from public.backroom_frame_ai_bindings b
      where b.device_id=p_device_id and b.runtime_session_id=p_runtime_session_id
        and b.revoked_at is null) then
    return pg_catalog.jsonb_build_object('ok',false,'reason','frame_ai_binding_already_active');
  end if;

  update public.backroom_frame_ai_binding_challenges c
  set revoked_at=v_now
  where c.consumed_at is null and c.revoked_at is null
    and (c.mcp_session_digest=p_session_digest
      or (c.device_id=p_device_id and c.runtime_session_id=p_runtime_session_id));

  v_expires_at:=least(v_now+interval '90 seconds',v_runtime.expires_at,v_mcp.expires_at,v_agent.expires_at);
  if v_expires_at<=v_now then
    return pg_catalog.jsonb_build_object('ok',false,'reason','binding_challenge_expired');
  end if;

  insert into public.backroom_frame_ai_binding_challenges(
    id,owner_id,room_id,participant_id,mcp_session_digest,agent_credential_digest,
    device_id,runtime_session_id,surface,app_id,app_identity_fingerprint,
    nonce_digest,created_at,expires_at
  ) values (
    p_challenge_id,p_owner_id,p_room_id,p_participant_id,p_session_digest,v_mcp.agent_credential_digest,
    p_device_id,p_runtime_session_id,p_surface,p_app_id,v_fingerprint,
    p_nonce_digest,v_now,v_expires_at
  );

  return pg_catalog.jsonb_build_object(
    'ok',true,'challenge_id',p_challenge_id,'expires_at',v_expires_at,
    'surface',p_surface,'app_id',p_app_id
  );
end;
$function$;
revoke all on function public.create_backroom_frame_ai_binding_challenge(
  uuid,text,uuid,uuid,uuid,text,uuid,uuid,text,text
) from public,anon,authenticated;
grant execute on function public.create_backroom_frame_ai_binding_challenge(
  uuid,text,uuid,uuid,uuid,text,uuid,uuid,text,text
) to service_role;

-- Completion is device-bearer-only. The initial non-locking read discovers the
-- MCP parent; all identity rows are then locked in a consistent parent-first
-- order before the challenge is consumed.
create or replace function public.complete_backroom_frame_ai_binding(
  p_challenge_id uuid,
  p_nonce_digest text,
  p_device_id uuid,
  p_runtime_session_id uuid,
  p_app_id text,
  p_app_identity_fingerprint text,
  p_runtime_identity_digest text,
  p_composer_identity_digest text,
  p_send_control_identity_digest text,
  p_provider_conversation_identity_digest text
) returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_now timestamptz:=pg_catalog.clock_timestamp();
  v_session_digest text;
  v_challenge public.backroom_frame_ai_binding_challenges%rowtype;
  v_mcp public.rub_minds_mcp_sessions%rowtype;
  v_participant public.participants%rowtype;
  v_device public.backroom_devices%rowtype;
  v_room_binding public.backroom_device_room_bindings%rowtype;
  v_runtime public.backroom_desktop_sessions%rowtype;
  v_agent public.agent_connections%rowtype;
  v_android_app public.backroom_device_apps%rowtype;
  v_desktop_app public.backroom_desktop_apps%rowtype;
  v_current_fingerprint text;
  v_expires_at timestamptz;
  v_binding_id uuid;
  v_expected_session_type text;
begin
  if p_challenge_id is null or p_device_id is null or p_runtime_session_id is null
    or p_nonce_digest is null or p_nonce_digest !~ '^[0-9a-f]{64}$'
    or p_app_id is null or p_app_identity_fingerprint is null
    or p_app_identity_fingerprint !~ '^[0-9a-f]{64}(\.[0-9a-f]{64})*$'
    or p_runtime_identity_digest is null or p_runtime_identity_digest !~ '^[0-9a-f]{64}$'
    or (p_composer_identity_digest is not null and p_composer_identity_digest !~ '^[0-9a-f]{64}$')
    or (p_send_control_identity_digest is not null and p_send_control_identity_digest !~ '^[0-9a-f]{64}$')
    or (p_provider_conversation_identity_digest is not null and p_provider_conversation_identity_digest !~ '^[0-9a-f]{64}$') then
    return pg_catalog.jsonb_build_object('ok',false,'reason','invalid_frame_ai_evidence');
  end if;

  select c.mcp_session_digest into v_session_digest
  from public.backroom_frame_ai_binding_challenges c
  where c.id=p_challenge_id and c.device_id=p_device_id
    and c.runtime_session_id=p_runtime_session_id;
  if v_session_digest is null then
    return pg_catalog.jsonb_build_object('ok',false,'reason','binding_challenge_not_found');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_session_digest,0));

  select s.* into v_mcp
  from public.rub_minds_mcp_sessions s
  where s.session_digest=v_session_digest
  for update;
  if not found or v_mcp.terminated_at is not null or v_mcp.expires_at<=v_now
    or v_mcp.agent_credential_ciphertext is null then
    return pg_catalog.jsonb_build_object('ok',false,'reason','group_ai_session_inactive');
  end if;

  -- Lock the remaining parents before the challenge row. Parent lifecycle
  -- triggers use this order so leave/revoke cannot deadlock with completion.
  select p.* into v_participant
  from public.participants p
  where p.id=v_mcp.participant_id and p.room_id=v_mcp.room_id
    and p.kind in ('original_session','model','external_agent')
    and p.status in ('connected','active','autonomous')
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok',false,'reason','ai_participant_inactive');
  end if;

  select d.* into v_device
  from public.backroom_devices d
  where d.device_id=p_device_id and d.status='active' and d.revoked_at is null
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok',false,'reason','device_not_active');
  end if;

  select rb.* into v_room_binding
  from public.backroom_device_room_bindings rb
  where rb.device_id=p_device_id and rb.room_id=v_mcp.room_id
    and rb.owner_id=v_device.owner_id and rb.revoked_at is null
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok',false,'reason','device_room_binding_inactive');
  end if;

  select s.* into v_runtime
  from public.backroom_desktop_sessions s
  where s.session_id=p_runtime_session_id and s.device_id=p_device_id
    and s.room_id=v_mcp.room_id and s.requested_by=v_device.owner_id
    and s.status='active' and s.expires_at>v_now
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok',false,'reason','runtime_session_inactive');
  end if;

  select a.* into v_agent
  from public.agent_connections a
  where a.credential_digest=v_mcp.agent_credential_digest
    and a.owner_id=v_device.owner_id and a.room_id=v_mcp.room_id
    and a.participant_id=v_mcp.participant_id
    and a.revoked_at is null and a.expires_at>v_now
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok',false,'reason','group_ai_credential_inactive');
  end if;

  select c.* into v_challenge
  from public.backroom_frame_ai_binding_challenges c
  where c.id=p_challenge_id and c.device_id=p_device_id
    and c.runtime_session_id=p_runtime_session_id
  for update;
  if not found or v_challenge.mcp_session_digest is distinct from v_session_digest
    or v_challenge.owner_id is distinct from v_device.owner_id
    or v_challenge.room_id is distinct from v_mcp.room_id
    or v_challenge.participant_id is distinct from v_mcp.participant_id
    or v_challenge.agent_credential_digest is distinct from v_mcp.agent_credential_digest then
    return pg_catalog.jsonb_build_object('ok',false,'reason','binding_challenge_scope_mismatch');
  end if;

  if v_challenge.consumed_at is not null then
    select b.id into v_binding_id
    from public.backroom_frame_ai_bindings b
    where b.challenge_id=v_challenge.id and b.mcp_session_digest=v_session_digest
      and b.device_id=p_device_id and b.runtime_session_id=p_runtime_session_id
      and b.app_id=p_app_id and b.app_identity_fingerprint=p_app_identity_fingerprint
      and b.runtime_identity_digest=p_runtime_identity_digest
      and b.composer_identity_digest is not distinct from p_composer_identity_digest
      and b.send_control_identity_digest is not distinct from p_send_control_identity_digest
      and b.provider_conversation_identity_digest is not distinct from p_provider_conversation_identity_digest
      and b.revoked_at is null and b.expires_at>v_now;
    if found then
      return pg_catalog.jsonb_build_object(
        'ok',true,'binding_id',v_binding_id,'replayed',true,
        'provider_conversation_attested',p_provider_conversation_identity_digest is not null
      );
    end if;
    return pg_catalog.jsonb_build_object('ok',false,'reason','binding_challenge_already_consumed');
  end if;

  if v_challenge.revoked_at is not null or v_challenge.expires_at<=v_now
    or v_challenge.nonce_digest is distinct from p_nonce_digest
    or v_challenge.app_id is distinct from p_app_id
    or v_challenge.app_identity_fingerprint is distinct from p_app_identity_fingerprint
    or v_mcp.agent_credential_digest is distinct from v_challenge.agent_credential_digest then
    return pg_catalog.jsonb_build_object('ok',false,'reason','binding_challenge_invalid_or_expired');
  end if;

  v_expected_session_type:=case when v_challenge.surface='terminal' then 'terminal' else 'screen' end;
  if v_runtime.session_type is distinct from v_expected_session_type then
    return pg_catalog.jsonb_build_object('ok',false,'reason','runtime_session_type_mismatch');
  end if;
  if (v_challenge.surface='android_app' and v_device.platform<>'android')
    or (v_challenge.surface='windows_app' and v_device.platform<>'windows')
    or (v_challenge.surface in ('desktop_app','terminal') and v_device.platform not in ('windows','macos','linux')) then
    return pg_catalog.jsonb_build_object('ok',false,'reason','device_platform_mismatch');
  end if;

  if v_challenge.surface='android_app' then
    select a.* into v_android_app
    from public.backroom_device_apps a
    where a.device_id=p_device_id and a.package_name=v_challenge.app_id
    for update;
    if not found then
      return pg_catalog.jsonb_build_object('ok',false,'reason','app_not_selected_on_device');
    end if;
    v_current_fingerprint:=v_android_app.signing_certificate_sha256;
  else
    select a.* into v_desktop_app
    from public.backroom_desktop_apps a
    where a.device_id=p_device_id and a.app_id=v_challenge.app_id::uuid
    for update;
    if not found then
      return pg_catalog.jsonb_build_object('ok',false,'reason','app_not_selected_on_device');
    end if;
    v_current_fingerprint:=v_desktop_app.executable_sha256;
  end if;
  if v_current_fingerprint is distinct from v_challenge.app_identity_fingerprint
    or v_current_fingerprint is distinct from p_app_identity_fingerprint then
    return pg_catalog.jsonb_build_object('ok',false,'reason','app_identity_changed');
  end if;

  if v_challenge.surface='terminal' then
    if p_composer_identity_digest is not null or p_send_control_identity_digest is not null
      or p_provider_conversation_identity_digest is not null then
      return pg_catalog.jsonb_build_object('ok',false,'reason','terminal_frame_must_not_claim_provider_composer');
    end if;
  elsif p_provider_conversation_identity_digest is not null
    and (p_composer_identity_digest is null or p_send_control_identity_digest is null) then
    return pg_catalog.jsonb_build_object('ok',false,'reason','incomplete_provider_conversation_attestation');
  end if;

  -- Challenge creation and completion both reclaim expired active slots so
  -- partial unique indexes cannot be blocked by a row whose lease elapsed.
  update public.backroom_frame_ai_bindings b
  set revoked_at=v_now,wake_enabled=false,wake_expires_at=null
  where b.revoked_at is null and b.expires_at<=v_now
    and (b.mcp_session_digest=v_session_digest
      or (b.device_id=p_device_id and b.runtime_session_id=p_runtime_session_id));

  if exists(select 1 from public.backroom_frame_ai_bindings b
      where b.mcp_session_digest=v_session_digest and b.revoked_at is null)
    or exists(select 1 from public.backroom_frame_ai_bindings b
      where b.device_id=p_device_id and b.runtime_session_id=p_runtime_session_id
        and b.revoked_at is null) then
    return pg_catalog.jsonb_build_object('ok',false,'reason','frame_ai_binding_already_active');
  end if;

  -- The binding lifetime is governed by its live parents, NOT the short
  -- challenge TTL. The nonce must be consumed within 90 seconds, but a
  -- successful attachment can live until any parent session expires.
  v_expires_at:=least(v_runtime.expires_at,v_mcp.expires_at,v_agent.expires_at);
  if v_expires_at<=v_now then
    return pg_catalog.jsonb_build_object('ok',false,'reason','frame_ai_binding_expired');
  end if;

  insert into public.backroom_frame_ai_bindings(
    challenge_id,owner_id,room_id,participant_id,mcp_session_digest,agent_credential_digest,
    device_id,runtime_session_id,surface,app_id,app_identity_fingerprint,
    runtime_identity_digest,composer_identity_digest,send_control_identity_digest,
    provider_conversation_identity_digest,expires_at
  ) values (
    v_challenge.id,v_challenge.owner_id,v_challenge.room_id,v_challenge.participant_id,
    v_session_digest,v_challenge.agent_credential_digest,
    p_device_id,p_runtime_session_id,v_challenge.surface,v_challenge.app_id,
    v_challenge.app_identity_fingerprint,p_runtime_identity_digest,
    p_composer_identity_digest,p_send_control_identity_digest,
    p_provider_conversation_identity_digest,v_expires_at
  ) returning id into v_binding_id;

  update public.backroom_frame_ai_binding_challenges
  set consumed_at=v_now
  where id=v_challenge.id and consumed_at is null and revoked_at is null;
  if not found then
    raise exception using errcode='40001',message='Frame binding challenge changed during completion';
  end if;

  return pg_catalog.jsonb_build_object(
    'ok',true,'binding_id',v_binding_id,'expires_at',v_expires_at,'replayed',false,
    'provider_conversation_attested',p_provider_conversation_identity_digest is not null
  );
end;
$function$;
revoke all on function public.complete_backroom_frame_ai_binding(
  uuid,text,uuid,uuid,text,text,text,text,text,text
) from public,anon,authenticated;
grant execute on function public.complete_backroom_frame_ai_binding(
  uuid,text,uuid,uuid,text,text,text,text,text,text
) to service_role;

create or replace function public.revoke_backroom_frame_ai_binding(
  p_binding_id uuid,
  p_owner_id uuid,
  p_room_id uuid,
  p_device_id uuid
) returns boolean
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_binding public.backroom_frame_ai_bindings%rowtype;
  v_now timestamptz:=pg_catalog.clock_timestamp();
begin
  if p_binding_id is null or p_owner_id is null or p_room_id is null or p_device_id is null then
    return false;
  end if;
  select b.* into v_binding
  from public.backroom_frame_ai_bindings b
  where b.id=p_binding_id and b.owner_id=p_owner_id
    and b.room_id=p_room_id and b.device_id=p_device_id
  for update;
  if not found then return false; end if;

  update public.backroom_frame_ai_bindings b
  set revoked_at=coalesce(b.revoked_at,v_now),wake_enabled=false,wake_expires_at=null
  where b.id=v_binding.id;
  update public.backroom_frame_ai_binding_challenges c
  set revoked_at=coalesce(c.revoked_at,v_now)
  where c.id=v_binding.challenge_id and c.consumed_at is null;
  return v_binding.revoked_at is null;
end;
$function$;
revoke all on function public.revoke_backroom_frame_ai_binding(uuid,uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.revoke_backroom_frame_ai_binding(uuid,uuid,uuid,uuid)
  to service_role;

-- Lifecycle invalidation is shared by all parent tables and runs with the
-- mutating server role. It never publishes or returns the binding secrets.
create or replace function public.revoke_backroom_frame_ai_bindings_for_scope(
  p_device_id uuid default null,
  p_room_id uuid default null,
  p_runtime_session_id uuid default null,
  p_mcp_session_digest text default null,
  p_participant_id uuid default null,
  p_agent_credential_digest text default null,
  p_surface text default null,
  p_app_id text default null
) returns void
language plpgsql
security invoker
set search_path=''
as $function$
declare v_now timestamptz:=pg_catalog.clock_timestamp();
begin
  if p_device_id is null and p_room_id is null and p_runtime_session_id is null
    and p_mcp_session_digest is null and p_participant_id is null
    and p_agent_credential_digest is null and p_surface is null and p_app_id is null then
    raise exception 'At least one frame binding scope is required';
  end if;

  update public.backroom_frame_ai_bindings b
  set revoked_at=coalesce(b.revoked_at,v_now),wake_enabled=false,wake_expires_at=null
  where b.revoked_at is null
    and (p_device_id is null or b.device_id=p_device_id)
    and (p_room_id is null or b.room_id=p_room_id)
    and (p_runtime_session_id is null or b.runtime_session_id=p_runtime_session_id)
    and (p_mcp_session_digest is null or b.mcp_session_digest=p_mcp_session_digest)
    and (p_participant_id is null or b.participant_id=p_participant_id)
    and (p_agent_credential_digest is null or b.agent_credential_digest=p_agent_credential_digest)
    and (p_surface is null or b.surface=p_surface)
    and (p_app_id is null or b.app_id=p_app_id);

  update public.backroom_frame_ai_binding_challenges c
  set revoked_at=coalesce(c.revoked_at,v_now)
  where c.consumed_at is null and c.revoked_at is null
    and (p_device_id is null or c.device_id=p_device_id)
    and (p_room_id is null or c.room_id=p_room_id)
    and (p_runtime_session_id is null or c.runtime_session_id=p_runtime_session_id)
    and (p_mcp_session_digest is null or c.mcp_session_digest=p_mcp_session_digest)
    and (p_participant_id is null or c.participant_id=p_participant_id)
    and (p_agent_credential_digest is null or c.agent_credential_digest=p_agent_credential_digest)
    and (p_surface is null or c.surface=p_surface)
    and (p_app_id is null or c.app_id=p_app_id);
end;
$function$;
revoke all on function public.revoke_backroom_frame_ai_bindings_for_scope(
  uuid,uuid,uuid,text,uuid,text,text,text
) from public,anon,authenticated;
grant execute on function public.revoke_backroom_frame_ai_bindings_for_scope(
  uuid,uuid,uuid,text,uuid,text,text,text
) to service_role;

create or replace function public.revoke_backroom_frame_ai_bindings_on_parent_change()
returns trigger
language plpgsql
security invoker
set search_path=''
as $function$
declare
  v_old jsonb:=pg_catalog.to_jsonb(old);
  v_new jsonb:=case when tg_op='DELETE' then '{}'::jsonb else pg_catalog.to_jsonb(new) end;
  v_changed boolean:=tg_op='DELETE';
begin
  if tg_table_name='rooms' then
    v_changed:=v_changed or v_new->>'owner_id' is distinct from v_old->>'owner_id';
    if v_changed then
      perform public.revoke_backroom_frame_ai_bindings_for_scope(
        p_room_id => (v_old->>'id')::uuid
      );
    end if;
  elsif tg_table_name='backroom_desktop_sessions' then
    v_changed:=v_changed or v_new->>'session_id' is distinct from v_old->>'session_id'
      or v_new->>'device_id' is distinct from v_old->>'device_id'
      or v_new->>'room_id' is distinct from v_old->>'room_id'
      or v_new->>'requested_by' is distinct from v_old->>'requested_by'
      or v_new->>'session_type' is distinct from v_old->>'session_type'
      or v_new->>'status' is distinct from 'active'
      or v_new->>'expires_at' is distinct from v_old->>'expires_at';
    if v_changed then
      perform public.revoke_backroom_frame_ai_bindings_for_scope(
        p_runtime_session_id => (v_old->>'session_id')::uuid
      );
    end if;
  elsif tg_table_name='rub_minds_mcp_sessions' then
    v_changed:=v_changed or v_new->>'room_id' is distinct from v_old->>'room_id'
      or v_new->>'participant_id' is distinct from v_old->>'participant_id'
      or v_new->>'agent_credential_digest' is distinct from v_old->>'agent_credential_digest'
      or v_new->>'terminated_at' is distinct from v_old->>'terminated_at'
      or v_new->>'expires_at' is distinct from v_old->>'expires_at';
    if v_changed then
      perform public.revoke_backroom_frame_ai_bindings_for_scope(
        p_mcp_session_digest => v_old->>'session_digest'
      );
    end if;
  elsif tg_table_name='participants' then
    v_changed:=v_changed or v_new->>'room_id' is distinct from v_old->>'room_id'
      or v_new->>'kind' is distinct from v_old->>'kind'
      or v_new->>'status' is distinct from v_old->>'status';
    if v_changed then
      perform public.revoke_backroom_frame_ai_bindings_for_scope(
        p_participant_id => (v_old->>'id')::uuid
      );
    end if;
  elsif tg_table_name='agent_connections' then
    v_changed:=v_changed or v_new->>'credential_digest' is distinct from v_old->>'credential_digest'
      or v_new->>'owner_id' is distinct from v_old->>'owner_id'
      or v_new->>'room_id' is distinct from v_old->>'room_id'
      or v_new->>'participant_id' is distinct from v_old->>'participant_id'
      or v_new->>'revoked_at' is distinct from v_old->>'revoked_at'
      or v_new->>'expires_at' is distinct from v_old->>'expires_at';
    if v_changed then
      perform public.revoke_backroom_frame_ai_bindings_for_scope(
        p_agent_credential_digest => v_old->>'credential_digest'
      );
    end if;
  elsif tg_table_name='backroom_devices' then
    v_changed:=v_changed or v_new->>'device_id' is distinct from v_old->>'device_id'
      or v_new->>'owner_id' is distinct from v_old->>'owner_id'
      or v_new->>'platform' is distinct from v_old->>'platform'
      or v_new->>'status' is distinct from 'active'
      or v_new->>'revoked_at' is distinct from v_old->>'revoked_at';
    if v_changed then
      perform public.revoke_backroom_frame_ai_bindings_for_scope(
        p_device_id => (v_old->>'device_id')::uuid
      );
    end if;
  elsif tg_table_name='backroom_device_room_bindings' then
    v_changed:=v_changed or v_new->>'device_id' is distinct from v_old->>'device_id'
      or v_new->>'room_id' is distinct from v_old->>'room_id'
      or v_new->>'owner_id' is distinct from v_old->>'owner_id'
      or v_new->>'revoked_at' is distinct from v_old->>'revoked_at';
    if v_changed then
      perform public.revoke_backroom_frame_ai_bindings_for_scope(
        p_device_id => (v_old->>'device_id')::uuid,
        p_room_id => (v_old->>'room_id')::uuid
      );
    end if;
  elsif tg_table_name='backroom_device_apps' then
    v_changed:=v_changed or v_new->>'device_id' is distinct from v_old->>'device_id'
      or v_new->>'package_name' is distinct from v_old->>'package_name'
      or v_new->>'signing_certificate_sha256' is distinct from v_old->>'signing_certificate_sha256';
    if v_changed then
      perform public.revoke_backroom_frame_ai_bindings_for_scope(
        p_device_id => (v_old->>'device_id')::uuid,
        p_surface => 'android_app',
        p_app_id => v_old->>'package_name'
      );
    end if;
  elsif tg_table_name='backroom_desktop_apps' then
    v_changed:=v_changed or v_new->>'device_id' is distinct from v_old->>'device_id'
      or v_new->>'app_id' is distinct from v_old->>'app_id'
      or v_new->>'executable_sha256' is distinct from v_old->>'executable_sha256';
    if v_changed then
      -- Desktop app UUIDs can be used by different desktop frame surfaces.
      -- Revoke any association to that selected executable on this device.
      perform public.revoke_backroom_frame_ai_bindings_for_scope(
        p_device_id => (v_old->>'device_id')::uuid,
        p_app_id => v_old->>'app_id'
      );
    end if;
  end if;

  if tg_op='DELETE' then return old; end if;
  return new;
end;
$function$;
revoke all on function public.revoke_backroom_frame_ai_bindings_on_parent_change()
  from public,anon,authenticated;
grant execute on function public.revoke_backroom_frame_ai_bindings_on_parent_change() to service_role;

drop trigger if exists backroom_frame_ai_room_lifecycle on public.rooms;
create trigger backroom_frame_ai_room_lifecycle
after update of owner_id or delete on public.rooms
for each row execute function public.revoke_backroom_frame_ai_bindings_on_parent_change();

drop trigger if exists backroom_frame_ai_session_lifecycle on public.backroom_desktop_sessions;
create trigger backroom_frame_ai_session_lifecycle
after update or delete on public.backroom_desktop_sessions
for each row execute function public.revoke_backroom_frame_ai_bindings_on_parent_change();

drop trigger if exists backroom_frame_ai_mcp_lifecycle on public.rub_minds_mcp_sessions;
create trigger backroom_frame_ai_mcp_lifecycle
after update or delete on public.rub_minds_mcp_sessions
for each row execute function public.revoke_backroom_frame_ai_bindings_on_parent_change();

drop trigger if exists backroom_frame_ai_participant_lifecycle on public.participants;
create trigger backroom_frame_ai_participant_lifecycle
after update or delete on public.participants
for each row execute function public.revoke_backroom_frame_ai_bindings_on_parent_change();

drop trigger if exists backroom_frame_ai_agent_lifecycle on public.agent_connections;
create trigger backroom_frame_ai_agent_lifecycle
after update or delete on public.agent_connections
for each row execute function public.revoke_backroom_frame_ai_bindings_on_parent_change();

drop trigger if exists backroom_frame_ai_device_lifecycle on public.backroom_devices;
create trigger backroom_frame_ai_device_lifecycle
after update or delete on public.backroom_devices
for each row execute function public.revoke_backroom_frame_ai_bindings_on_parent_change();

drop trigger if exists backroom_frame_ai_device_room_lifecycle on public.backroom_device_room_bindings;
create trigger backroom_frame_ai_device_room_lifecycle
after update or delete on public.backroom_device_room_bindings
for each row execute function public.revoke_backroom_frame_ai_bindings_on_parent_change();

drop trigger if exists backroom_frame_ai_android_app_lifecycle on public.backroom_device_apps;
create trigger backroom_frame_ai_android_app_lifecycle
after update or delete on public.backroom_device_apps
for each row execute function public.revoke_backroom_frame_ai_bindings_on_parent_change();

drop trigger if exists backroom_frame_ai_desktop_app_lifecycle on public.backroom_desktop_apps;
create trigger backroom_frame_ai_desktop_app_lifecycle
after update or delete on public.backroom_desktop_apps
for each row execute function public.revoke_backroom_frame_ai_bindings_on_parent_change();
