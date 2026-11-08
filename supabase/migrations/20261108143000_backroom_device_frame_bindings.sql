-- Host-independent association between an already-joined AI MCP session and
-- an owner-selected live phone, desktop-app, or terminal runtime.
begin;

alter table public.backroom_desktop_sessions
  add column if not exists target_app_id text,
  add column if not exists target_app_fingerprint text;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
    where conrelid='public.backroom_desktop_sessions'::regclass
      and conname='backroom_desktop_sessions_target_app_pair_check') then
    alter table public.backroom_desktop_sessions add constraint backroom_desktop_sessions_target_app_pair_check
      check ((target_app_id is null and target_app_fingerprint is null)
        or (target_app_id is not null and char_length(btrim(target_app_id)) between 1 and 255
          and target_app_fingerprint is not null
          and target_app_fingerprint ~ '^[0-9a-f]{64}([.][0-9a-f]{64})*$'));
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
    where conrelid='public.backroom_desktop_sessions'::regclass
      and conname='backroom_desktop_sessions_terminal_target_empty_check') then
    alter table public.backroom_desktop_sessions add constraint backroom_desktop_sessions_terminal_target_empty_check
      check (session_type <> 'terminal' or (target_app_id is null and target_app_fingerprint is null));
  end if;
end;
$$;

create table if not exists public.backroom_device_frame_binding_challenges (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  requested_by uuid not null references auth.users(id) on delete cascade,
  target_participant_id uuid not null references public.participants(id) on delete cascade,
  target_session_digest text not null references public.rub_minds_mcp_sessions(session_digest) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  device_id uuid not null references public.backroom_devices(device_id) on delete cascade,
  runtime_session_id uuid not null references public.backroom_desktop_sessions(session_id) on delete cascade,
  surface text not null check (surface in ('android_app','desktop_app','terminal')),
  target_app_id text,
  target_app_fingerprint text,
  nonce_digest text not null unique check (nonce_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  constraint backroom_device_frame_challenge_expiry_check check (expires_at > created_at),
  constraint backroom_device_frame_challenge_target_check check (
    (surface='terminal' and target_app_id is null and target_app_fingerprint is null)
    or (surface='android_app'
      and target_app_id is not null and target_app_id ~ '^[A-Za-z][A-Za-z0-9_]*([.][A-Za-z][A-Za-z0-9_]*)+$'
      and target_app_fingerprint is not null and target_app_fingerprint ~ '^[0-9a-f]{64}([.][0-9a-f]{64})*$')
    or (surface='desktop_app'
      and target_app_id is not null and target_app_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and target_app_fingerprint is not null and target_app_fingerprint ~ '^[0-9a-f]{64}$')
  ),
  constraint backroom_device_frame_challenge_terminal_state_check check (not (consumed_at is not null and revoked_at is not null))
);
alter table public.backroom_device_frame_binding_challenges enable row level security;
revoke all on table public.backroom_device_frame_binding_challenges from public,anon,authenticated;
grant select,insert,update,delete on table public.backroom_device_frame_binding_challenges to service_role;
create index if not exists backroom_device_frame_challenges_pending_idx
  on public.backroom_device_frame_binding_challenges(device_id,runtime_session_id,target_participant_id,expires_at)
  where consumed_at is null and revoked_at is null;
create index if not exists backroom_device_frame_challenges_requester_idx
  on public.backroom_device_frame_binding_challenges(requested_by,created_at desc);
create index if not exists backroom_device_frame_challenges_session_idx
  on public.backroom_device_frame_binding_challenges(target_session_digest,expires_at)
  where consumed_at is null and revoked_at is null;

create table if not exists public.backroom_device_frame_bindings (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  challenge_id uuid not null unique references public.backroom_device_frame_binding_challenges(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  session_digest text not null references public.rub_minds_mcp_sessions(session_digest) on delete cascade
    check (session_digest ~ '^[0-9a-f]{64}$'),
  device_id uuid not null references public.backroom_devices(device_id) on delete cascade,
  runtime_session_id uuid not null references public.backroom_desktop_sessions(session_id) on delete cascade,
  surface text not null check (surface in ('android_app','desktop_app','terminal')),
  target_app_id text,
  target_app_fingerprint text,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  constraint backroom_device_frame_binding_expiry_check check (expires_at > created_at),
  constraint backroom_device_frame_binding_target_check check (
    (surface='terminal' and target_app_id is null and target_app_fingerprint is null)
    or (surface='android_app'
      and target_app_id is not null and target_app_id ~ '^[A-Za-z][A-Za-z0-9_]*([.][A-Za-z][A-Za-z0-9_]*)+$'
      and target_app_fingerprint is not null and target_app_fingerprint ~ '^[0-9a-f]{64}([.][0-9a-f]{64})*$')
    or (surface='desktop_app'
      and target_app_id is not null and target_app_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and target_app_fingerprint is not null and target_app_fingerprint ~ '^[0-9a-f]{64}$')
  )
);
alter table public.backroom_device_frame_bindings enable row level security;
revoke all on table public.backroom_device_frame_bindings from public,anon,authenticated;
grant select,insert,update,delete on table public.backroom_device_frame_bindings to service_role;
create unique index if not exists backroom_device_frame_binding_active_participant_idx
  on public.backroom_device_frame_bindings(room_id,participant_id) where revoked_at is null;
create unique index if not exists backroom_device_frame_binding_active_session_idx
  on public.backroom_device_frame_bindings(session_digest) where revoked_at is null;
create unique index if not exists backroom_device_frame_binding_active_runtime_idx
  on public.backroom_device_frame_bindings(device_id,runtime_session_id) where revoked_at is null;
create index if not exists backroom_device_frame_binding_expiry_idx
  on public.backroom_device_frame_bindings(expires_at) where revoked_at is null;

-- The participant is selected at challenge creation. Completion can only attach
-- that same participant through its existing live MCP session; it cannot create
-- or impersonate an AI participant. Parent rows are locked before the challenge.
create or replace function public.complete_backroom_device_frame_binding(
  p_challenge_id uuid,p_nonce_digest text,p_session_digest text
) returns jsonb
language plpgsql security definer set search_path=''
as $function$
declare
  v_now timestamptz:=pg_catalog.clock_timestamp();
  v_challenge public.backroom_device_frame_binding_challenges%rowtype;
  v_session public.rub_minds_mcp_sessions%rowtype;
  v_runtime public.backroom_desktop_sessions%rowtype;
  v_device public.backroom_devices%rowtype;
  v_participant public.participants%rowtype;
  v_connection public.agent_connections%rowtype;
  v_existing public.backroom_device_frame_bindings%rowtype;
  v_binding public.backroom_device_frame_bindings%rowtype;
  v_room_owner uuid;
  v_valid_app boolean:=false;
  v_expires_at timestamptz;
begin
  if p_challenge_id is null or p_nonce_digest is null or p_nonce_digest !~ '^[0-9a-f]{64}$'
    or p_session_digest is null or p_session_digest !~ '^[0-9a-f]{64}$' then
    return pg_catalog.jsonb_build_object('ok',false,'reason','invalid_binding_request');
  end if;

  -- Read immutable scope without locking the challenge. Lock parents first to
  -- avoid deadlocks with device/app/runtime/session invalidation triggers.
  select c.* into v_challenge from public.backroom_device_frame_binding_challenges c
  where c.id=p_challenge_id and c.nonce_digest=p_nonce_digest;
  if not found then return pg_catalog.jsonb_build_object('ok',false,'reason','challenge_not_found_or_invalid'); end if;

  select s.* into v_session from public.rub_minds_mcp_sessions s
  where s.session_digest=p_session_digest for update;
  if not found or v_session.terminated_at is not null or v_session.expires_at<=v_now
    or v_session.agent_credential_ciphertext is null or v_session.agent_credential_digest is null
    or v_session.room_id is null or v_session.participant_id is null then
    return pg_catalog.jsonb_build_object('ok',false,'reason','active_joined_mcp_session_required');
  end if;
  if v_session.session_digest is distinct from v_challenge.target_session_digest
    or v_session.room_id is distinct from v_challenge.room_id
    or v_session.participant_id is distinct from v_challenge.target_participant_id then
    return pg_catalog.jsonb_build_object('ok',false,'reason','selected_ai_session_mismatch');
  end if;

  select r.* into v_runtime from public.backroom_desktop_sessions r
  where r.session_id=v_challenge.runtime_session_id and r.device_id=v_challenge.device_id
    and r.room_id=v_challenge.room_id and r.requested_by=v_challenge.requested_by
    and r.status='active' and r.expires_at>v_now for share;
  if not found then return pg_catalog.jsonb_build_object('ok',false,'reason','frame_runtime_unavailable'); end if;

  select d.* into v_device from public.backroom_devices d
  where d.device_id=v_challenge.device_id for share;
  if not found or v_device.status<>'active' or v_device.owner_id is distinct from v_challenge.requested_by then
    return pg_catalog.jsonb_build_object('ok',false,'reason','device_unavailable');
  end if;
  perform 1 from public.backroom_device_room_bindings rb
    where rb.device_id=v_challenge.device_id and rb.room_id=v_challenge.room_id
      and rb.owner_id=v_challenge.requested_by and rb.revoked_at is null for share;
  if not found then return pg_catalog.jsonb_build_object('ok',false,'reason','device_not_bound_to_group'); end if;

  if (v_challenge.surface='terminal' and (v_runtime.session_type<>'terminal'
      or v_runtime.target_app_id is not null or v_runtime.target_app_fingerprint is not null))
    or (v_challenge.surface='android_app' and (v_device.platform<>'android' or v_runtime.session_type<>'screen'
      or v_runtime.target_app_id is distinct from v_challenge.target_app_id
      or v_runtime.target_app_fingerprint is distinct from v_challenge.target_app_fingerprint))
    or (v_challenge.surface='desktop_app' and (v_device.platform not in ('windows','macos','linux')
      or v_runtime.session_type<>'screen' or v_runtime.target_app_id is distinct from v_challenge.target_app_id
      or v_runtime.target_app_fingerprint is distinct from v_challenge.target_app_fingerprint)) then
    return pg_catalog.jsonb_build_object('ok',false,'reason','frame_runtime_identity_changed');
  end if;

  if v_challenge.surface='android_app' then
    perform 1 from public.backroom_device_apps a where a.device_id=v_challenge.device_id
      and a.package_name=v_challenge.target_app_id
      and a.signing_certificate_sha256=v_challenge.target_app_fingerprint for share;
    v_valid_app:=found;
  elsif v_challenge.surface='desktop_app' then
    perform 1 from public.backroom_desktop_apps a where a.device_id=v_challenge.device_id
      and a.app_id::text=v_challenge.target_app_id
      and a.executable_sha256=v_challenge.target_app_fingerprint for share;
    v_valid_app:=found;
  else
    v_valid_app:=true; -- Owner-approved live PTY attachment, not process attestation.
  end if;
  if not v_valid_app then return pg_catalog.jsonb_build_object('ok',false,'reason','selected_app_identity_changed'); end if;

  select p.* into v_participant from public.participants p
  where p.id=v_session.participant_id and p.room_id=v_session.room_id
    and p.kind in ('original_session','model','external_agent')
    and p.status in ('waiting','connected','active','autonomous') for share;
  if not found then return pg_catalog.jsonb_build_object('ok',false,'reason','active_ai_participant_required'); end if;

  select ac.* into v_connection from public.agent_connections ac
  where ac.credential_digest=v_session.agent_credential_digest
    and ac.room_id=v_session.room_id and ac.participant_id=v_session.participant_id
    and ac.revoked_at is null and ac.expires_at>v_now for share;
  if not found then return pg_catalog.jsonb_build_object('ok',false,'reason','ai_participant_credential_inactive'); end if;

  select r.owner_id into v_room_owner from public.rooms r where r.id=v_challenge.room_id for share;
  if not found or (v_room_owner is distinct from v_challenge.requested_by and not exists(
    select 1 from public.participants h where h.room_id=v_challenge.room_id
      and h.user_id=v_challenge.requested_by and h.kind='human'
      and h.status in ('connected','active','autonomous'))) then
    return pg_catalog.jsonb_build_object('ok',false,'reason','frame_requester_is_not_active_group_member');
  end if;

  -- Serialize single-use challenge consumption after all parent locks.
  select c.* into v_challenge from public.backroom_device_frame_binding_challenges c
  where c.id=p_challenge_id and c.nonce_digest=p_nonce_digest for update;
  if not found then return pg_catalog.jsonb_build_object('ok',false,'reason','challenge_not_found_or_invalid'); end if;
  if v_challenge.consumed_at is not null then
    select b.* into v_existing from public.backroom_device_frame_bindings b where b.challenge_id=v_challenge.id;
    if found and v_existing.session_digest=p_session_digest and v_existing.participant_id=v_session.participant_id
      and v_existing.revoked_at is null and v_existing.expires_at>v_now then
      return pg_catalog.jsonb_build_object('ok',true,'bound',true,'binding_id',v_existing.id,
        'room_id',v_existing.room_id,'participant_id',v_existing.participant_id,'device_id',v_existing.device_id,
        'runtime_session_id',v_existing.runtime_session_id,'surface',v_existing.surface,
        'target_app_id',v_existing.target_app_id,'expires_at',v_existing.expires_at,'replayed',true);
    end if;
    return pg_catalog.jsonb_build_object('ok',false,'reason','challenge_already_consumed');
  end if;
  if v_challenge.revoked_at is not null or v_challenge.expires_at<=v_now then
    return pg_catalog.jsonb_build_object('ok',false,'reason','challenge_expired_or_revoked');
  end if;

  update public.backroom_device_frame_bindings set revoked_at=v_now
    where revoked_at is null and expires_at<=v_now
      and (room_id=v_session.room_id or session_digest=p_session_digest
        or (device_id=v_challenge.device_id and runtime_session_id=v_challenge.runtime_session_id));
  v_expires_at:=least(v_runtime.expires_at,v_session.expires_at,v_connection.expires_at);
  if v_expires_at<=v_now then return pg_catalog.jsonb_build_object('ok',false,'reason','binding_parent_expired'); end if;

  begin
    insert into public.backroom_device_frame_bindings(
      challenge_id,requested_by,room_id,participant_id,session_digest,device_id,runtime_session_id,
      surface,target_app_id,target_app_fingerprint,expires_at
    ) values (
      v_challenge.id,v_challenge.requested_by,v_challenge.room_id,v_session.participant_id,p_session_digest,
      v_challenge.device_id,v_challenge.runtime_session_id,v_challenge.surface,
      v_challenge.target_app_id,v_challenge.target_app_fingerprint,v_expires_at
    ) returning * into v_binding;
  exception when unique_violation then
    return pg_catalog.jsonb_build_object('ok',false,'reason','participant_or_frame_already_bound');
  end;

  update public.backroom_device_frame_binding_challenges set consumed_at=v_now
    where id=v_challenge.id and consumed_at is null and revoked_at is null;
  if not found then raise exception using errcode='40001',message='Device-frame challenge changed during completion'; end if;

  return pg_catalog.jsonb_build_object('ok',true,'bound',true,'binding_id',v_binding.id,
    'room_id',v_binding.room_id,'participant_id',v_binding.participant_id,'device_id',v_binding.device_id,
    'runtime_session_id',v_binding.runtime_session_id,'surface',v_binding.surface,
    'target_app_id',v_binding.target_app_id,'expires_at',v_binding.expires_at,'replayed',false);
end;
$function$;
revoke all on function public.complete_backroom_device_frame_binding(uuid,text,text) from public,anon,authenticated;
grant execute on function public.complete_backroom_device_frame_binding(uuid,text,text) to service_role;

create or replace function public.revoke_device_frame_bindings_on_mcp_change()
returns trigger language plpgsql security definer set search_path=''
as $function$
begin
  if new.terminated_at is not null or new.expires_at<=pg_catalog.clock_timestamp()
    or new.agent_credential_digest is distinct from old.agent_credential_digest
    or new.room_id is distinct from old.room_id or new.participant_id is distinct from old.participant_id then
    update public.backroom_device_frame_bindings set revoked_at=coalesce(revoked_at,pg_catalog.clock_timestamp())
      where session_digest=old.session_digest and revoked_at is null;
    update public.backroom_device_frame_binding_challenges set revoked_at=coalesce(revoked_at,pg_catalog.clock_timestamp())
      where target_session_digest=old.session_digest and consumed_at is null and revoked_at is null;
  end if;
  return new;
end;
$function$;
revoke all on function public.revoke_device_frame_bindings_on_mcp_change() from public,anon,authenticated;
create trigger backroom_device_frame_mcp_lifecycle_trigger
after update of agent_credential_digest,room_id,participant_id,terminated_at,expires_at
on public.rub_minds_mcp_sessions for each row execute function public.revoke_device_frame_bindings_on_mcp_change();

create or replace function public.revoke_device_frame_bindings_on_runtime_change()
returns trigger language plpgsql security definer set search_path=''
as $function$
begin
  if tg_op='DELETE' then
    update public.backroom_device_frame_bindings set revoked_at=coalesce(revoked_at,pg_catalog.clock_timestamp())
      where runtime_session_id=old.session_id and revoked_at is null;
    update public.backroom_device_frame_binding_challenges set revoked_at=coalesce(revoked_at,pg_catalog.clock_timestamp())
      where runtime_session_id=old.session_id and consumed_at is null and revoked_at is null;
    return old;
  end if;
  if new.status<>'active' or new.expires_at<=pg_catalog.clock_timestamp()
    or new.session_id is distinct from old.session_id or new.device_id is distinct from old.device_id
    or new.room_id is distinct from old.room_id or new.requested_by is distinct from old.requested_by
    or new.session_type is distinct from old.session_type or new.target_app_id is distinct from old.target_app_id
    or new.target_app_fingerprint is distinct from old.target_app_fingerprint then
    update public.backroom_device_frame_bindings set revoked_at=coalesce(revoked_at,pg_catalog.clock_timestamp())
      where runtime_session_id=old.session_id and revoked_at is null;
    update public.backroom_device_frame_binding_challenges set revoked_at=coalesce(revoked_at,pg_catalog.clock_timestamp())
      where runtime_session_id=old.session_id and consumed_at is null and revoked_at is null;
  else
    -- Android screen runtimes use short rolling leases. Extend a still-live
    -- frame association on heartbeat, but never beyond the MCP session or its
    -- active AI credential. Never revive an expired or revoked association.
    update public.backroom_device_frame_bindings b
      set expires_at=least(new.expires_at,s.expires_at,ac.expires_at)
      from public.rub_minds_mcp_sessions s
      join public.agent_connections ac on ac.credential_digest=s.agent_credential_digest
      where s.session_digest=b.session_digest
        and b.runtime_session_id=old.session_id
        and b.revoked_at is null and b.expires_at>pg_catalog.clock_timestamp()
        and s.terminated_at is null and s.expires_at>pg_catalog.clock_timestamp()
        and ac.revoked_at is null and ac.expires_at>pg_catalog.clock_timestamp();

    -- Shorten pending challenges when a runtime lease is shortened; a longer
    -- heartbeat never extends the original one-time challenge window.
    if new.expires_at<old.expires_at then
      update public.backroom_device_frame_binding_challenges
        set expires_at=least(expires_at,new.expires_at)
        where runtime_session_id=old.session_id
          and consumed_at is null and revoked_at is null;
    end if;
  end if;
  return new;
end;
$function$;
revoke all on function public.revoke_device_frame_bindings_on_runtime_change() from public,anon,authenticated;
create trigger backroom_device_frame_runtime_lifecycle_trigger
after update of session_id,device_id,room_id,requested_by,session_type,status,expires_at,target_app_id,target_app_fingerprint
or delete on public.backroom_desktop_sessions
for each row execute function public.revoke_device_frame_bindings_on_runtime_change();

create or replace function public.revoke_device_frame_bindings_on_device_change()
returns trigger language plpgsql security definer set search_path=''
as $function$
begin
  if new.status<>'active' or new.device_id is distinct from old.device_id
    or new.owner_id is distinct from old.owner_id or new.platform is distinct from old.platform then
    update public.backroom_device_frame_bindings set revoked_at=coalesce(revoked_at,pg_catalog.clock_timestamp())
      where device_id=old.device_id and revoked_at is null;
    update public.backroom_device_frame_binding_challenges set revoked_at=coalesce(revoked_at,pg_catalog.clock_timestamp())
      where device_id=old.device_id and consumed_at is null and revoked_at is null;
  end if;
  return new;
end;
$function$;
revoke all on function public.revoke_device_frame_bindings_on_device_change() from public,anon,authenticated;
create trigger backroom_device_frame_device_lifecycle_trigger
after update of device_id,owner_id,platform,status on public.backroom_devices
for each row execute function public.revoke_device_frame_bindings_on_device_change();

create or replace function public.revoke_device_frame_bindings_on_unpair()
returns trigger language plpgsql security definer set search_path=''
as $function$
begin
  if tg_op='DELETE' then
    update public.backroom_device_frame_bindings set revoked_at=coalesce(revoked_at,pg_catalog.clock_timestamp())
      where device_id=old.device_id and room_id=old.room_id and revoked_at is null;
    update public.backroom_device_frame_binding_challenges set revoked_at=coalesce(revoked_at,pg_catalog.clock_timestamp())
      where device_id=old.device_id and room_id=old.room_id and consumed_at is null and revoked_at is null;
    return old;
  end if;
  if new.revoked_at is not null or new.device_id is distinct from old.device_id
    or new.room_id is distinct from old.room_id or new.owner_id is distinct from old.owner_id then
    update public.backroom_device_frame_bindings set revoked_at=coalesce(revoked_at,pg_catalog.clock_timestamp())
      where device_id=old.device_id and room_id=old.room_id and revoked_at is null;
    update public.backroom_device_frame_binding_challenges set revoked_at=coalesce(revoked_at,pg_catalog.clock_timestamp())
      where device_id=old.device_id and room_id=old.room_id and consumed_at is null and revoked_at is null;
  end if;
  return new;
end;
$function$;
revoke all on function public.revoke_device_frame_bindings_on_unpair() from public,anon,authenticated;
create trigger backroom_device_frame_unpair_lifecycle_trigger
after update of device_id,room_id,owner_id,revoked_at or delete
on public.backroom_device_room_bindings for each row execute function public.revoke_device_frame_bindings_on_unpair();

create or replace function public.revoke_device_frame_bindings_on_agent_change()
returns trigger language plpgsql security definer set search_path=''
as $function$
begin
  if tg_op='DELETE' then
    update public.backroom_device_frame_bindings b set revoked_at=coalesce(b.revoked_at,pg_catalog.clock_timestamp())
      from public.rub_minds_mcp_sessions s
      where s.session_digest=b.session_digest and s.agent_credential_digest=old.credential_digest and b.revoked_at is null;
    update public.backroom_device_frame_binding_challenges c
      set revoked_at=coalesce(c.revoked_at,pg_catalog.clock_timestamp())
      from public.rub_minds_mcp_sessions s
      where s.session_digest=c.target_session_digest
        and s.agent_credential_digest=old.credential_digest
        and c.consumed_at is null and c.revoked_at is null;
    return old;
  end if;
  if new.revoked_at is not null or new.expires_at<=pg_catalog.clock_timestamp()
    or new.credential_digest is distinct from old.credential_digest
    or new.owner_id is distinct from old.owner_id or new.room_id is distinct from old.room_id
    or new.participant_id is distinct from old.participant_id then
    update public.backroom_device_frame_bindings b set revoked_at=coalesce(b.revoked_at,pg_catalog.clock_timestamp())
      from public.rub_minds_mcp_sessions s
      where s.session_digest=b.session_digest and s.agent_credential_digest=old.credential_digest and b.revoked_at is null;
    update public.backroom_device_frame_binding_challenges c
      set revoked_at=coalesce(c.revoked_at,pg_catalog.clock_timestamp())
      from public.rub_minds_mcp_sessions s
      where s.session_digest=c.target_session_digest
        and s.agent_credential_digest=old.credential_digest
        and c.consumed_at is null and c.revoked_at is null;
  end if;
  return new;
end;
$function$;
revoke all on function public.revoke_device_frame_bindings_on_agent_change() from public,anon,authenticated;
create trigger backroom_device_frame_agent_lifecycle_trigger
after update of credential_digest,owner_id,room_id,participant_id,expires_at,revoked_at or delete
on public.agent_connections for each row execute function public.revoke_device_frame_bindings_on_agent_change();

create or replace function public.revoke_device_frame_bindings_on_participant_change()
returns trigger language plpgsql security definer set search_path=''
as $function$
begin
  if new.status not in ('waiting','connected','active','autonomous')
    or new.kind not in ('original_session','model','external_agent') or new.room_id is distinct from old.room_id then
    update public.backroom_device_frame_bindings set revoked_at=coalesce(revoked_at,pg_catalog.clock_timestamp())
      where participant_id=old.id and revoked_at is null;
  end if;
  return new;
end;
$function$;
revoke all on function public.revoke_device_frame_bindings_on_participant_change() from public,anon,authenticated;
create trigger backroom_device_frame_participant_lifecycle_trigger
after update of room_id,kind,status on public.participants
for each row execute function public.revoke_device_frame_bindings_on_participant_change();

create or replace function public.revoke_device_frame_bindings_on_android_app_change()
returns trigger language plpgsql security definer set search_path=''
as $function$
begin
  update public.backroom_device_frame_bindings set revoked_at=coalesce(revoked_at,pg_catalog.clock_timestamp())
    where device_id=old.device_id and surface='android_app' and target_app_id=old.package_name
      and target_app_fingerprint=old.signing_certificate_sha256 and revoked_at is null;
  update public.backroom_device_frame_binding_challenges set revoked_at=coalesce(revoked_at,pg_catalog.clock_timestamp())
    where device_id=old.device_id and surface='android_app' and target_app_id=old.package_name
      and target_app_fingerprint=old.signing_certificate_sha256 and consumed_at is null and revoked_at is null;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$function$;
revoke all on function public.revoke_device_frame_bindings_on_android_app_change() from public,anon,authenticated;
create trigger backroom_device_frame_android_app_lifecycle_trigger
after update of device_id,package_name,signing_certificate_sha256 or delete
on public.backroom_device_apps for each row execute function public.revoke_device_frame_bindings_on_android_app_change();

create or replace function public.revoke_device_frame_bindings_on_desktop_app_change()
returns trigger language plpgsql security definer set search_path=''
as $function$
begin
  update public.backroom_device_frame_bindings set revoked_at=coalesce(revoked_at,pg_catalog.clock_timestamp())
    where device_id=old.device_id and surface='desktop_app' and target_app_id=old.app_id::text
      and target_app_fingerprint=old.executable_sha256 and revoked_at is null;
  update public.backroom_device_frame_binding_challenges set revoked_at=coalesce(revoked_at,pg_catalog.clock_timestamp())
    where device_id=old.device_id and surface='desktop_app' and target_app_id=old.app_id::text
      and target_app_fingerprint=old.executable_sha256 and consumed_at is null and revoked_at is null;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$function$;
revoke all on function public.revoke_device_frame_bindings_on_desktop_app_change() from public,anon,authenticated;
create trigger backroom_device_frame_desktop_app_lifecycle_trigger
after update of device_id,app_id,executable_sha256 or delete
on public.backroom_desktop_apps for each row execute function public.revoke_device_frame_bindings_on_desktop_app_change();

commit;
