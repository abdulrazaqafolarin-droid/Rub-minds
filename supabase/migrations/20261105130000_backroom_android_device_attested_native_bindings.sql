-- Device-attested binding between one native Android composer and one joined group AI session.
-- The browser never supplies or receives provider-conversation identity digests.
create table if not exists public.backroom_android_native_bindings (
  binding_id uuid primary key references public.backroom_input_bindings(id) on delete cascade,
  device_id uuid not null references public.backroom_devices(device_id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  screen_session_id uuid not null references public.backroom_desktop_sessions(session_id) on delete cascade,
  app_package_name text not null check (app_package_name ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'),
  app_signer_sha256 text not null check (app_signer_sha256 ~ '^[a-f0-9]{64}(\.[a-f0-9]{64})*$'),
  composer_identity_digest text not null check (composer_identity_digest ~ '^[a-f0-9]{64}$'),
  send_control_identity_digest text not null check (send_control_identity_digest ~ '^[a-f0-9]{64}$'),
  provider_conversation_identity_digest text not null check (provider_conversation_identity_digest ~ '^[a-f0-9]{64}$'),
  attested_at timestamptz not null default pg_catalog.clock_timestamp(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  check (expires_at > attested_at)
);
alter table public.backroom_android_native_bindings enable row level security;
revoke all on table public.backroom_android_native_bindings from public,anon,authenticated;
grant select,insert,update,delete on table public.backroom_android_native_bindings to service_role;

create unique index if not exists backroom_android_native_binding_one_per_screen_idx
  on public.backroom_android_native_bindings(device_id,screen_session_id)
  where revoked_at is null;
create index if not exists backroom_android_native_binding_device_active_idx
  on public.backroom_android_native_bindings(device_id,room_id,expires_at)
  where revoked_at is null;

alter table public.backroom_android_commands
  add column if not exists native_wake_binding_id uuid
    references public.backroom_android_native_bindings(binding_id) on delete set null;
alter table public.backroom_android_commands
  add column if not exists native_wake_job_id uuid
    references public.backroom_wake_jobs(id) on delete set null;
alter table public.backroom_android_commands
  add column if not exists native_wake_lease_token_digest text;
alter table public.backroom_android_commands
  add column if not exists native_wake_handoff_id uuid;

do $constraints$
begin
  if not exists(select 1 from pg_catalog.pg_constraint
    where conrelid='public.backroom_android_commands'::regclass
      and conname='backroom_android_native_wake_command_scope_check') then
    alter table public.backroom_android_commands
      add constraint backroom_android_native_wake_command_scope_check
      check (
        (native_wake_binding_id is null and native_wake_job_id is null
          and native_wake_lease_token_digest is null and native_wake_handoff_id is null)
        or
        (native_wake_binding_id is not null and native_wake_job_id is not null
          and native_wake_lease_token_digest ~ '^[a-f0-9]{64}$'
          and native_wake_handoff_id is not null)
      );
  end if;
end;
$constraints$;

create unique index if not exists backroom_android_one_active_native_wake_command_per_binding_idx
  on public.backroom_android_commands(native_wake_binding_id)
  where native_wake_binding_id is not null and status in ('pending','leased');
create unique index if not exists backroom_android_native_wake_handoff_id_idx
  on public.backroom_android_commands(native_wake_handoff_id)
  where native_wake_handoff_id is not null;

-- A paired Android device may act as its own queue host. Its host credential
-- digest is the already-enrolled device-token digest; no new plaintext secret
-- is created or returned to the browser.
create or replace function public.register_backroom_android_wake_host(
  p_device_id uuid,
  p_owner_id uuid,
  p_device_token_digest text,
  p_ttl_seconds integer default 86400
)
returns boolean
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_changed integer;
  v_expires_at timestamptz;
begin
  if p_device_id is null or p_owner_id is null
    or p_device_token_digest is null or p_device_token_digest !~ '^[a-f0-9]{64}$'
    or p_ttl_seconds is null or p_ttl_seconds<3600 or p_ttl_seconds>86400 then
    raise exception 'Invalid Android native wake host registration';
  end if;
  if not exists(
    select 1 from public.backroom_devices d
    where d.device_id=p_device_id and d.owner_id=p_owner_id
      and d.platform='android' and d.status='active'
      and d.token_digest=p_device_token_digest and d.revoked_at is null
  ) then
    return false;
  end if;
  v_expires_at:=pg_catalog.clock_timestamp()+pg_catalog.make_interval(secs=>p_ttl_seconds);
  insert into public.backroom_hosts(host_id,owner_id,credential_digest,expires_at)
  values(p_device_id::text,p_owner_id,p_device_token_digest,v_expires_at)
  on conflict(host_id) do update
    set expires_at=excluded.expires_at
    where public.backroom_hosts.owner_id=excluded.owner_id
      and public.backroom_hosts.credential_digest=excluded.credential_digest
      and public.backroom_hosts.revoked_at is null;
  get diagnostics v_changed=row_count;
  return v_changed=1;
end;
$function$;

revoke all on function public.register_backroom_android_wake_host(uuid,uuid,text,integer)
  from public,anon,authenticated;
grant execute on function public.register_backroom_android_wake_host(uuid,uuid,text,integer)
  to service_role;

-- Called only by the device-bearer authenticated Edge endpoint after it has
-- verified the current device, room, screen session and selected-app signer.
-- It writes the phone-produced digests directly from the companion to service role.
create or replace function public.attest_backroom_android_native_binding(
  p_binding_id uuid,
  p_device_id uuid,
  p_room_id uuid,
  p_screen_session_id uuid,
  p_app_package_name text,
  p_app_signer_sha256 text,
  p_composer_identity_digest text,
  p_send_control_identity_digest text,
  p_provider_conversation_identity_digest text
)
returns boolean
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_binding public.backroom_input_bindings%rowtype;
  v_session public.backroom_desktop_sessions%rowtype;
  v_existing public.backroom_android_native_bindings%rowtype;
begin
  if p_binding_id is null or p_device_id is null or p_room_id is null
    or p_screen_session_id is null
    or p_app_package_name is null
      or p_app_package_name !~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'
    or p_app_signer_sha256 is null
      or p_app_signer_sha256 !~ '^[a-f0-9]{64}(\.[a-f0-9]{64})*$'
    or p_composer_identity_digest is null
      or p_composer_identity_digest !~ '^[a-f0-9]{64}$'
    or p_send_control_identity_digest is null
      or p_send_control_identity_digest !~ '^[a-f0-9]{64}$'
    or p_provider_conversation_identity_digest is null
      or p_provider_conversation_identity_digest !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid Android native binding attestation';
  end if;

  select * into v_binding
  from public.backroom_input_bindings b
  where b.id=p_binding_id
  for update;
  if not found or v_binding.surface<>'android_app'
    or v_binding.host_id<>p_device_id::text
    or v_binding.room_id<>p_room_id
    or v_binding.target_identity_fingerprint<>p_app_signer_sha256
    or v_binding.revoked_at is not null then
    return false;
  end if;

  if not exists(
    select 1 from public.backroom_devices d
    join public.backroom_device_room_bindings rb
      on rb.device_id=d.device_id and rb.room_id=p_room_id and rb.owner_id=d.owner_id
    where d.device_id=p_device_id and d.owner_id=v_binding.owner_id
      and d.platform='android' and d.status='active'
      and d.revoked_at is null and rb.revoked_at is null
  ) then
    return false;
  end if;

  select * into v_session
  from public.backroom_desktop_sessions s
  where s.session_id=p_screen_session_id and s.device_id=p_device_id
    and s.room_id=p_room_id and s.session_type='screen'
    and s.status='active' and s.expires_at>pg_catalog.clock_timestamp();
  if not found then return false; end if;

  if not exists(
    select 1 from public.backroom_device_apps a
    where a.device_id=p_device_id and a.package_name=p_app_package_name
      and a.signing_certificate_sha256=p_app_signer_sha256
  ) then
    return false;
  end if;

  if not exists(
    select 1
    from public.rooms r
    join public.participants p on p.room_id=r.id and p.id=v_binding.participant_id
    join public.rub_minds_mcp_sessions s on s.room_id=r.id
      and s.participant_id=p.id and s.session_digest=v_binding.session_digest
    join public.agent_connections ac on ac.room_id=r.id and ac.participant_id=p.id
      and ac.owner_id=r.owner_id
    where r.id=p_room_id and r.owner_id=v_binding.owner_id
      and p.kind in ('original_session','model','external_agent')
      and p.status in ('connected','active','autonomous')
      and s.terminated_at is null and s.expires_at>pg_catalog.clock_timestamp()
      and s.agent_credential_ciphertext is not null
      and ac.revoked_at is null and ac.expires_at>pg_catalog.clock_timestamp()
  ) then
    return false;
  end if;

  select * into v_existing
  from public.backroom_android_native_bindings m
  where m.binding_id=p_binding_id
  for update;
  if found then
    return v_existing.device_id=p_device_id
      and v_existing.room_id=p_room_id
      and v_existing.screen_session_id=p_screen_session_id
      and v_existing.app_package_name=p_app_package_name
      and v_existing.app_signer_sha256=p_app_signer_sha256
      and v_existing.composer_identity_digest=p_composer_identity_digest
      and v_existing.send_control_identity_digest=p_send_control_identity_digest
      and v_existing.provider_conversation_identity_digest=p_provider_conversation_identity_digest
      and v_existing.revoked_at is null
      and v_existing.expires_at>pg_catalog.clock_timestamp();
  end if;

  insert into public.backroom_android_native_bindings(
    binding_id,device_id,room_id,screen_session_id,app_package_name,
    app_signer_sha256,composer_identity_digest,send_control_identity_digest,
    provider_conversation_identity_digest,expires_at
  ) values(
    p_binding_id,p_device_id,p_room_id,p_screen_session_id,p_app_package_name,
    p_app_signer_sha256,p_composer_identity_digest,p_send_control_identity_digest,
    p_provider_conversation_identity_digest,v_session.expires_at
  );

  if v_binding.provider_conversation_identity_digest is null then
    update public.backroom_input_bindings
    set provider_conversation_identity_digest=p_provider_conversation_identity_digest,
        updated_at=pg_catalog.clock_timestamp()
    where id=p_binding_id and provider_conversation_identity_digest is null;
    if not found then
      raise exception 'Provider identity binding changed during device attestation';
    end if;
  elsif v_binding.provider_conversation_identity_digest<>p_provider_conversation_identity_digest then
    raise exception 'Provider identity conflicts with existing input binding';
  end if;

  return true;
end;
$function$;

revoke all on function public.attest_backroom_android_native_binding(
  uuid,uuid,uuid,uuid,text,text,text,text,text
) from public,anon,authenticated;
grant execute on function public.attest_backroom_android_native_binding(
  uuid,uuid,uuid,uuid,text,text,text,text,text
) to service_role;

-- The immutable-digest guard permits exactly one null -> attested-digest
-- transition backed by the private mapping created inside the RPC above.
create or replace function public.guard_backroom_input_binding_provider_identity()
returns trigger
language plpgsql
security invoker
set search_path=''
as $function$
begin
  if new.provider_conversation_identity_digest is distinct from old.provider_conversation_identity_digest then
    if old.provider_conversation_identity_digest is null
      and new.provider_conversation_identity_digest is not null
      and exists(
        select 1 from public.backroom_android_native_bindings m
        where m.binding_id=new.id and m.provider_conversation_identity_digest=new.provider_conversation_identity_digest
          and m.revoked_at is null and m.expires_at>pg_catalog.clock_timestamp()
      ) then
      return new;
    end if;
    raise check_violation using
      message='Provider conversation identity is immutable; revoke and register a new binding';
  end if;
  return new;
end;
$function$;

revoke all on function public.guard_backroom_input_binding_provider_identity()
  from public,anon,authenticated;
grant execute on function public.guard_backroom_input_binding_provider_identity()
  to service_role;

-- Any stop/expiry/revoke removes the attestation and revokes its group input.
create or replace function public.revoke_backroom_android_native_binding_scope()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_binding_id uuid;
begin
  if new.revoked_at is null and new.expires_at>pg_catalog.clock_timestamp() then
    return new;
  end if;
  for v_binding_id in
    select m.binding_id from public.backroom_android_native_bindings m
    where m.device_id=new.device_id and m.screen_session_id=new.session_id
      and m.revoked_at is null
  loop
    update public.backroom_android_native_bindings
    set revoked_at=coalesce(revoked_at,pg_catalog.clock_timestamp()),
        updated_at=pg_catalog.clock_timestamp()
    where binding_id=v_binding_id and revoked_at is null;
  end loop;
  return new;
end;
$function$;

revoke all on function public.revoke_backroom_android_native_binding_scope()
  from public,anon,authenticated;
grant execute on function public.revoke_backroom_android_native_binding_scope()
  to service_role;

drop trigger if exists backroom_android_native_binding_session_scope_trigger
  on public.backroom_desktop_sessions;
create trigger backroom_android_native_binding_session_scope_trigger
after update of status,expires_at on public.backroom_desktop_sessions
for each row
when (old.status is distinct from new.status or old.expires_at is distinct from new.expires_at)
execute function public.revoke_backroom_android_native_binding_scope();

create or replace function public.revoke_backroom_android_native_binding_dependents()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
begin
  if old.revoked_at is null and new.revoked_at is not null then
    update public.backroom_input_bindings
    set revoked_at=coalesce(revoked_at,pg_catalog.clock_timestamp()),
        wake_enabled=false,wake_last_revoked_grant_id=coalesce(wake_grant_id,wake_last_revoked_grant_id),
        wake_grant_id=null,wake_expires_at=null,confirmed_at=null,
        updated_at=pg_catalog.clock_timestamp()
    where id=new.binding_id and revoked_at is null;

    update public.backroom_android_commands
    set status='rejected',result='native_binding_revoked',lease_until=null
    where native_wake_binding_id=new.binding_id and status in ('pending','leased');
  end if;
  return new;
end;
$function$;

revoke all on function public.revoke_backroom_android_native_binding_dependents()
  from public,anon,authenticated;
grant execute on function public.revoke_backroom_android_native_binding_dependents()
  to service_role;

drop trigger if exists backroom_android_native_binding_revoke_dependents_trigger
  on public.backroom_android_native_bindings;
create trigger backroom_android_native_binding_revoke_dependents_trigger
after update of revoked_at on public.backroom_android_native_bindings
for each row
when (old.revoked_at is null and new.revoked_at is not null)
execute function public.revoke_backroom_android_native_binding_dependents();

create or replace function public.revoke_backroom_android_native_bindings_for_device()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
begin
  if old.status<>'revoked' and new.status='revoked' then
    update public.backroom_android_native_bindings
    set revoked_at=coalesce(revoked_at,pg_catalog.clock_timestamp()),
        updated_at=pg_catalog.clock_timestamp()
    where device_id=new.device_id and revoked_at is null;
    update public.backroom_hosts
    set revoked_at=coalesce(revoked_at,pg_catalog.clock_timestamp())
    where host_id=new.device_id::text and owner_id=new.owner_id and revoked_at is null;
  end if;
  return new;
end;
$function$;

revoke all on function public.revoke_backroom_android_native_bindings_for_device()
  from public,anon,authenticated;
grant execute on function public.revoke_backroom_android_native_bindings_for_device()
  to service_role;

drop trigger if exists backroom_android_native_binding_device_revoke_trigger
  on public.backroom_devices;
create trigger backroom_android_native_binding_device_revoke_trigger
after update of status on public.backroom_devices
for each row
when (old.status<>'revoked' and new.status='revoked')
execute function public.revoke_backroom_android_native_bindings_for_device();

-- The job insert guard also verifies the live device attestation, not merely a
-- non-null digest. The queue cannot dispatch a stale or unpaired phone target.
create or replace function public.sync_backroom_wake_job_provider_identity()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_binding public.backroom_input_bindings%rowtype;
begin
  select * into v_binding
  from public.backroom_input_bindings b
  where b.id=new.binding_id and b.owner_id=new.owner_id
    and b.room_id=new.room_id and b.participant_id=new.participant_id
    and b.host_id=new.host_id and b.session_digest=new.session_digest
    and b.space_id=new.space_id and b.session_id=new.session_id
    and b.target_id=new.target_id
    and b.target_identity_fingerprint=new.target_identity_fingerprint
    and b.target_revision=new.target_revision;

  if not found then
    raise exception 'Backroom wake job does not match an exact registered input binding';
  end if;
  if new.provider_conversation_identity_digest is not null
    and new.provider_conversation_identity_digest is distinct from v_binding.provider_conversation_identity_digest then
    raise exception 'Backroom wake provider-conversation digest does not match its binding';
  end if;
  if v_binding.surface in ('desktop_app','windows_app','android_app')
    and v_binding.provider_conversation_identity_digest is null then
    raise exception 'Native wake requires a registered provider-conversation identity digest';
  end if;
  if v_binding.surface='android_app' and not exists(
    select 1 from public.backroom_android_native_bindings m
    join public.backroom_devices d on d.device_id=m.device_id
    join public.backroom_device_room_bindings rb on rb.device_id=m.device_id and rb.room_id=m.room_id
      and rb.owner_id=v_binding.owner_id and rb.revoked_at is null
    join public.backroom_desktop_sessions ds on ds.session_id=m.screen_session_id
      and ds.device_id=m.device_id and ds.room_id=m.room_id
    where m.binding_id=v_binding.id and m.device_id::text=v_binding.host_id
      and m.room_id=v_binding.room_id
      and m.provider_conversation_identity_digest=v_binding.provider_conversation_identity_digest
      and m.app_signer_sha256=v_binding.target_identity_fingerprint
      and m.revoked_at is null and m.expires_at>pg_catalog.clock_timestamp()
      and d.status='active' and d.platform='android'
      and ds.status='active' and ds.expires_at>pg_catalog.clock_timestamp()
  ) then
    raise exception 'Android native wake requires a live device-attested target mapping';
  end if;
  new.provider_conversation_identity_digest:=v_binding.provider_conversation_identity_digest;
  return new;
end;
$function$;

revoke all on function public.sync_backroom_wake_job_provider_identity()
  from public,anon,authenticated;
grant execute on function public.sync_backroom_wake_job_provider_identity()
  to service_role;

comment on table public.backroom_android_native_bindings is
  'Device-bearer-attested mapping of one Android screen session and app composer to one private Rub Minds group input binding. Provider digest never comes from the browser.';
comment on function public.attest_backroom_android_native_binding(uuid,uuid,uuid,uuid,text,text,text,text,text) is
  'Service-role-only attestation called exclusively after the paired Android device bearer, active screen session, selected app signer and live MCP binding are verified.';
