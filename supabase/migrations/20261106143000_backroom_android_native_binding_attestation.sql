-- Owner-approved, device-bearer-completed Android binding attestation.
-- The browser relays only a short-lived nonce. All UI identity digests come
-- directly from the authenticated Android companion and stay out of WebRTC.

create table if not exists public.backroom_android_native_binding_challenges (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  binding_id uuid not null references public.backroom_input_bindings(id) on delete cascade,
  device_id uuid not null references public.backroom_devices(device_id) on delete cascade,
  screen_session_id uuid not null references public.backroom_desktop_sessions(session_id) on delete cascade,
  app_package_name text not null check (app_package_name ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'),
  nonce_digest text not null check (nonce_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  check (expires_at > created_at),
  check (not (consumed_at is not null and revoked_at is not null))
);
alter table public.backroom_android_native_binding_challenges enable row level security;
revoke all on table public.backroom_android_native_binding_challenges from public,anon,authenticated;
grant select,insert,update,delete on table public.backroom_android_native_binding_challenges to service_role;
create index if not exists backroom_android_native_binding_challenges_pending_idx
  on public.backroom_android_native_binding_challenges(device_id,screen_session_id,expires_at)
  where consumed_at is null and revoked_at is null;

create table if not exists public.backroom_android_native_bindings (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  challenge_id uuid not null unique references public.backroom_android_native_binding_challenges(id) on delete cascade,
  binding_id uuid not null references public.backroom_input_bindings(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  device_id uuid not null references public.backroom_devices(device_id) on delete cascade,
  screen_session_id uuid not null references public.backroom_desktop_sessions(session_id) on delete cascade,
  app_package_name text not null check (app_package_name ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'),
  app_signing_certificate_sha256 text not null
    check (app_signing_certificate_sha256 ~ '^[0-9a-f]{64}(\.[0-9a-f]{64})*$'),
  composer_identity_digest text not null check (composer_identity_digest ~ '^[0-9a-f]{64}$'),
  send_control_identity_digest text not null check (send_control_identity_digest ~ '^[0-9a-f]{64}$'),
  provider_conversation_identity_digest text not null check (provider_conversation_identity_digest ~ '^[0-9a-f]{64}$'),
  attested_at timestamptz not null default pg_catalog.clock_timestamp(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
alter table public.backroom_android_native_bindings enable row level security;
revoke all on table public.backroom_android_native_bindings from public,anon,authenticated;
grant select,insert,update,delete on table public.backroom_android_native_bindings to service_role;
create unique index if not exists backroom_android_native_bindings_active_group_binding_idx
  on public.backroom_android_native_bindings(binding_id) where revoked_at is null;
create unique index if not exists backroom_android_native_bindings_active_phone_session_idx
  on public.backroom_android_native_bindings(device_id,screen_session_id) where revoked_at is null;
create index if not exists backroom_android_native_bindings_expiry_idx
  on public.backroom_android_native_bindings(expires_at) where revoked_at is null;

-- Permit exactly one initial null -> digest transition, and only when a live
-- device-attested mapping already proves that digest for this exact binding.
-- Subsequent changes always require revoke/re-register.
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
      and old.surface='android_app' and new.surface='android_app'
      and old.wake_enabled=false and new.wake_enabled=false
      and old.revoked_at is null and new.revoked_at is null
      and not exists(select 1 from public.backroom_wake_jobs j where j.binding_id=old.id)
      and exists(
        select 1 from public.backroom_android_native_bindings n
        where n.binding_id=old.id
          and n.provider_conversation_identity_digest=new.provider_conversation_identity_digest
          and n.revoked_at is null and n.expires_at>pg_catalog.clock_timestamp()
      ) then
      return new;
    end if;
    raise check_violation using
      message = 'Provider conversation identity is immutable; revoke and register a new binding';
  end if;
  return new;
end;
$function$;
revoke all on function public.guard_backroom_input_binding_provider_identity()
  from public,anon,authenticated;
grant execute on function public.guard_backroom_input_binding_provider_identity() to service_role;

create or replace function public.revoke_backroom_android_native_binding_on_screen_change()
returns trigger
language plpgsql
security invoker
set search_path=''
as $function$
declare
  v_now timestamptz:=pg_catalog.clock_timestamp();
  v_identity_changed boolean;
begin
  v_identity_changed:=new.session_id is distinct from old.session_id
    or new.device_id is distinct from old.device_id
    or new.room_id is distinct from old.room_id
    or new.requested_by is distinct from old.requested_by
    or new.session_type is distinct from old.session_type;
  if v_identity_changed or new.status is distinct from 'active' or new.expires_at<=v_now then
    update public.backroom_android_native_bindings
    set revoked_at=coalesce(revoked_at,v_now),expires_at=least(expires_at,v_now)
    where screen_session_id=old.session_id and revoked_at is null;
    update public.backroom_android_native_binding_challenges
    set revoked_at=coalesce(revoked_at,v_now),expires_at=least(expires_at,v_now)
    where screen_session_id=old.session_id and consumed_at is null and revoked_at is null;
  elsif new.expires_at<old.expires_at then
    update public.backroom_android_native_bindings
    set expires_at=least(expires_at,new.expires_at)
    where screen_session_id=old.session_id and revoked_at is null;
    update public.backroom_android_native_binding_challenges
    set expires_at=least(expires_at,new.expires_at)
    where screen_session_id=old.session_id and consumed_at is null and revoked_at is null;
  end if;
  return new;
end;
$function$;
revoke all on function public.revoke_backroom_android_native_binding_on_screen_change()
  from public,anon,authenticated;
grant execute on function public.revoke_backroom_android_native_binding_on_screen_change() to service_role;
drop trigger if exists backroom_android_native_binding_screen_lifecycle_trigger
  on public.backroom_desktop_sessions;
create trigger backroom_android_native_binding_screen_lifecycle_trigger
after update of session_id,device_id,room_id,requested_by,session_type,status,expires_at on public.backroom_desktop_sessions
for each row execute function public.revoke_backroom_android_native_binding_on_screen_change();

create or replace function public.revoke_backroom_android_native_binding_on_group_binding_change()
returns trigger
language plpgsql
security invoker
set search_path=''
as $function$
declare
  v_identity_changed boolean;
  v_now timestamptz:=pg_catalog.clock_timestamp();
begin
  v_identity_changed:=new.owner_id is distinct from old.owner_id
    or new.room_id is distinct from old.room_id
    or new.participant_id is distinct from old.participant_id
    or new.host_id is distinct from old.host_id
    or new.session_digest is distinct from old.session_digest
    or new.space_id is distinct from old.space_id
    or new.session_id is distinct from old.session_id
    or new.target_id is distinct from old.target_id
    or new.target_identity_fingerprint is distinct from old.target_identity_fingerprint
    or new.target_revision is distinct from old.target_revision
    or new.surface is distinct from old.surface
    or new.locator_kind is distinct from old.locator_kind
    or new.locator_value is distinct from old.locator_value;
  if new.revoked_at is not null or v_identity_changed then
    update public.backroom_android_native_bindings
    set revoked_at=coalesce(revoked_at,v_now),expires_at=least(expires_at,v_now)
    where binding_id=old.id and revoked_at is null;
    update public.backroom_android_native_binding_challenges
    set revoked_at=coalesce(revoked_at,v_now),expires_at=least(expires_at,v_now)
    where binding_id=old.id and consumed_at is null and revoked_at is null;
  end if;
  return new;
end;
$function$;
revoke all on function public.revoke_backroom_android_native_binding_on_group_binding_change()
  from public,anon,authenticated;
grant execute on function public.revoke_backroom_android_native_binding_on_group_binding_change() to service_role;
drop trigger if exists backroom_android_native_binding_group_binding_lifecycle_trigger
  on public.backroom_input_bindings;
create trigger backroom_android_native_binding_group_binding_lifecycle_trigger
after update of owner_id,room_id,participant_id,host_id,session_digest,space_id,session_id,target_id,target_identity_fingerprint,target_revision,surface,locator_kind,locator_value,revoked_at on public.backroom_input_bindings
for each row execute function public.revoke_backroom_android_native_binding_on_group_binding_change();

create or replace function public.revoke_backroom_android_native_binding_on_room_unpair()
returns trigger
language plpgsql
security invoker
set search_path=''
as $function$
declare
  v_now timestamptz:=pg_catalog.clock_timestamp();
  v_identity_changed boolean:=false;
begin
  if tg_op='DELETE' then
    update public.backroom_android_native_bindings
    set revoked_at=coalesce(revoked_at,v_now),expires_at=least(expires_at,v_now)
    where device_id=old.device_id and room_id=old.room_id and revoked_at is null;
    update public.backroom_android_native_binding_challenges
    set revoked_at=coalesce(revoked_at,v_now),expires_at=least(expires_at,v_now)
    where device_id=old.device_id and room_id=old.room_id
      and consumed_at is null and revoked_at is null;
    return old;
  end if;
  v_identity_changed:=new.device_id is distinct from old.device_id
    or new.room_id is distinct from old.room_id
    or new.owner_id is distinct from old.owner_id;
  if new.revoked_at is not null or v_identity_changed then
    update public.backroom_android_native_bindings
    set revoked_at=coalesce(revoked_at,v_now),expires_at=least(expires_at,v_now)
    where device_id=old.device_id and room_id=old.room_id and revoked_at is null;
    update public.backroom_android_native_binding_challenges
    set revoked_at=coalesce(revoked_at,v_now),expires_at=least(expires_at,v_now)
    where device_id=old.device_id and room_id=old.room_id
      and consumed_at is null and revoked_at is null;
  end if;
  return new;
end;
$function$;
revoke all on function public.revoke_backroom_android_native_binding_on_room_unpair()
  from public,anon,authenticated;
grant execute on function public.revoke_backroom_android_native_binding_on_room_unpair() to service_role;
drop trigger if exists backroom_android_native_binding_room_unpair_trigger
  on public.backroom_device_room_bindings;
create trigger backroom_android_native_binding_room_unpair_trigger
after update of device_id,room_id,owner_id,revoked_at or delete on public.backroom_device_room_bindings
for each row execute function public.revoke_backroom_android_native_binding_on_room_unpair();

create or replace function public.revoke_backroom_android_native_binding_on_app_signer_change()
returns trigger
language plpgsql
security invoker
set search_path=''
as $function$
declare
  v_now timestamptz:=pg_catalog.clock_timestamp();
begin
  if tg_op='DELETE' then
    update public.backroom_android_native_bindings
    set revoked_at=coalesce(revoked_at,v_now),expires_at=least(expires_at,v_now)
    where device_id=old.device_id and app_package_name=old.package_name and revoked_at is null;
    update public.backroom_android_native_binding_challenges
    set revoked_at=coalesce(revoked_at,v_now),expires_at=least(expires_at,v_now)
    where device_id=old.device_id and app_package_name=old.package_name
      and consumed_at is null and revoked_at is null;
    return old;
  end if;
  if new.device_id is distinct from old.device_id
    or new.package_name is distinct from old.package_name
    or new.signing_certificate_sha256 is distinct from old.signing_certificate_sha256 then
    -- The attestation is tied to the OLD installed-app identity.
    update public.backroom_android_native_bindings
    set revoked_at=coalesce(revoked_at,v_now),expires_at=least(expires_at,v_now)
    where device_id=old.device_id and app_package_name=old.package_name and revoked_at is null;
    update public.backroom_android_native_binding_challenges
    set revoked_at=coalesce(revoked_at,v_now),expires_at=least(expires_at,v_now)
    where device_id=old.device_id and app_package_name=old.package_name
      and consumed_at is null and revoked_at is null;
  end if;
  return new;
end;
$function$;
revoke all on function public.revoke_backroom_android_native_binding_on_app_signer_change()
  from public,anon,authenticated;
grant execute on function public.revoke_backroom_android_native_binding_on_app_signer_change() to service_role;
drop trigger if exists backroom_android_native_binding_app_signer_trigger
  on public.backroom_device_apps;
create trigger backroom_android_native_binding_app_signer_trigger
after update of device_id,package_name,signing_certificate_sha256 or delete on public.backroom_device_apps
for each row execute function public.revoke_backroom_android_native_binding_on_app_signer_change();

create or replace function public.revoke_backroom_android_native_binding_on_host_change()
returns trigger
language plpgsql
security invoker
set search_path=''
as $function$
declare
  v_now timestamptz:=pg_catalog.clock_timestamp();
begin
  if new.revoked_at is not null or new.expires_at<=v_now
    or new.host_id is distinct from old.host_id
    or new.owner_id is distinct from old.owner_id then
    update public.backroom_android_native_bindings n
    set revoked_at=coalesce(n.revoked_at,v_now),expires_at=least(n.expires_at,v_now)
    from public.backroom_input_bindings b
    where b.id=n.binding_id and b.host_id=old.host_id and n.revoked_at is null;
    update public.backroom_android_native_binding_challenges c
    set revoked_at=coalesce(c.revoked_at,v_now),expires_at=least(c.expires_at,v_now)
    from public.backroom_input_bindings b
    where b.id=c.binding_id and b.host_id=old.host_id
      and c.consumed_at is null and c.revoked_at is null;
  elsif new.expires_at<old.expires_at then
    update public.backroom_android_native_bindings n
    set expires_at=least(n.expires_at,new.expires_at)
    from public.backroom_input_bindings b
    where b.id=n.binding_id and b.host_id=old.host_id and n.revoked_at is null;
    update public.backroom_android_native_binding_challenges c
    set expires_at=least(c.expires_at,new.expires_at)
    from public.backroom_input_bindings b
    where c.binding_id=b.id and b.host_id=old.host_id
      and c.consumed_at is null and c.revoked_at is null;
  end if;
  return new;
end;
$function$;
revoke all on function public.revoke_backroom_android_native_binding_on_host_change()
  from public,anon,authenticated;
grant execute on function public.revoke_backroom_android_native_binding_on_host_change() to service_role;
drop trigger if exists backroom_android_native_binding_host_lifecycle_trigger
  on public.backroom_hosts;
create trigger backroom_android_native_binding_host_lifecycle_trigger
after update of host_id,owner_id,revoked_at,expires_at on public.backroom_hosts
for each row execute function public.revoke_backroom_android_native_binding_on_host_change();

create or replace function public.revoke_backroom_android_native_binding_on_device_change()
returns trigger
language plpgsql
security invoker
set search_path=''
as $function$
declare
  v_now timestamptz:=pg_catalog.clock_timestamp();
begin
  if new.status is distinct from 'active' or new.platform is distinct from 'android'
    or new.device_id is distinct from old.device_id or new.owner_id is distinct from old.owner_id then
    update public.backroom_android_native_bindings
    set revoked_at=coalesce(revoked_at,v_now),expires_at=least(expires_at,v_now)
    where device_id=old.device_id and revoked_at is null;
    update public.backroom_android_native_binding_challenges
    set revoked_at=coalesce(revoked_at,v_now),expires_at=least(expires_at,v_now)
    where device_id=old.device_id and consumed_at is null and revoked_at is null;
  end if;
  return new;
end;
$function$;
revoke all on function public.revoke_backroom_android_native_binding_on_device_change()
  from public,anon,authenticated;
grant execute on function public.revoke_backroom_android_native_binding_on_device_change() to service_role;
drop trigger if exists backroom_android_native_binding_device_lifecycle_trigger
  on public.backroom_devices;
create trigger backroom_android_native_binding_device_lifecycle_trigger
after update of device_id,owner_id,platform,status on public.backroom_devices
for each row execute function public.revoke_backroom_android_native_binding_on_device_change();

create or replace function public.revoke_backroom_android_native_binding_on_agent_connection_change()
returns trigger
language plpgsql
security invoker
set search_path=''
as $function$
declare
  v_now timestamptz:=pg_catalog.clock_timestamp();
  v_revoke boolean:=false;
  v_credential_digest text;
  v_owner_id uuid;
  v_room_id uuid;
  v_participant_id uuid;
  v_expiry timestamptz;
begin
  if tg_op='DELETE' then
    v_revoke:=true;
    v_credential_digest:=old.credential_digest;
    v_owner_id:=old.owner_id;
    v_room_id:=old.room_id;
    v_participant_id:=old.participant_id;
  else
    v_credential_digest:=old.credential_digest;
    v_owner_id:=old.owner_id;
    v_room_id:=old.room_id;
    v_participant_id:=old.participant_id;
    v_expiry:=new.expires_at;
    v_revoke:=new.revoked_at is not null or new.expires_at<=v_now
      or new.credential_digest is distinct from old.credential_digest
      or new.owner_id is distinct from old.owner_id
      or new.room_id is distinct from old.room_id
      or new.participant_id is distinct from old.participant_id;
  end if;

  if v_revoke then
    update public.backroom_android_native_bindings n
    set revoked_at=coalesce(n.revoked_at,v_now),expires_at=least(n.expires_at,v_now)
    from public.backroom_input_bindings b
    join public.rub_minds_mcp_sessions m on m.session_digest=b.session_digest
    where n.binding_id=b.id and m.agent_credential_digest=v_credential_digest
      and b.owner_id=v_owner_id and b.room_id=v_room_id
      and b.participant_id=v_participant_id and n.revoked_at is null;
    update public.backroom_android_native_binding_challenges c
    set revoked_at=coalesce(c.revoked_at,v_now),expires_at=least(c.expires_at,v_now)
    from public.backroom_input_bindings b
    join public.rub_minds_mcp_sessions m on m.session_digest=b.session_digest
    where c.binding_id=b.id and m.agent_credential_digest=v_credential_digest
      and b.owner_id=v_owner_id and b.room_id=v_room_id
      and b.participant_id=v_participant_id
      and c.consumed_at is null and c.revoked_at is null;
  elsif new.expires_at<old.expires_at then
    -- A shorter AI credential lease caps its native mapping and any challenge.
    update public.backroom_android_native_bindings n
    set expires_at=least(n.expires_at,v_expiry)
    from public.backroom_input_bindings b
    join public.rub_minds_mcp_sessions m on m.session_digest=b.session_digest
    where n.binding_id=b.id and m.agent_credential_digest=v_credential_digest
      and b.owner_id=v_owner_id and b.room_id=v_room_id
      and b.participant_id=v_participant_id and n.revoked_at is null;
    update public.backroom_android_native_binding_challenges c
    set expires_at=least(c.expires_at,v_expiry)
    from public.backroom_input_bindings b
    join public.rub_minds_mcp_sessions m on m.session_digest=b.session_digest
    where c.binding_id=b.id and m.agent_credential_digest=v_credential_digest
      and b.owner_id=v_owner_id and b.room_id=v_room_id
      and b.participant_id=v_participant_id
      and c.consumed_at is null and c.revoked_at is null;
  end if;

  if tg_op='DELETE' then return old; end if;
  return new;
end;
$function$;
revoke all on function public.revoke_backroom_android_native_binding_on_agent_connection_change()
  from public,anon,authenticated;
grant execute on function public.revoke_backroom_android_native_binding_on_agent_connection_change() to service_role;
drop trigger if exists backroom_android_native_binding_agent_connection_lifecycle_trigger
  on public.agent_connections;
create trigger backroom_android_native_binding_agent_connection_lifecycle_trigger
after update of credential_digest,owner_id,room_id,participant_id,revoked_at,expires_at or delete
on public.agent_connections
for each row execute function public.revoke_backroom_android_native_binding_on_agent_connection_change();

create or replace function public.revoke_backroom_android_native_binding_on_mcp_session_change()
returns trigger
language plpgsql
security invoker
set search_path=''
as $function$
declare
  v_now timestamptz:=pg_catalog.clock_timestamp();
begin
  if tg_op='DELETE' then
    update public.backroom_android_native_bindings n
    set revoked_at=coalesce(n.revoked_at,v_now),expires_at=least(n.expires_at,v_now)
    from public.backroom_input_bindings b
    where n.binding_id=b.id and b.session_digest=old.session_digest and n.revoked_at is null;
    update public.backroom_android_native_binding_challenges c
    set revoked_at=coalesce(c.revoked_at,v_now),expires_at=least(c.expires_at,v_now)
    from public.backroom_input_bindings b
    where c.binding_id=b.id and b.session_digest=old.session_digest
      and c.consumed_at is null and c.revoked_at is null;
    return old;
  end if;
  if new.terminated_at is not null or new.expires_at<=v_now
    or new.session_digest is distinct from old.session_digest
    or new.agent_credential_digest is distinct from old.agent_credential_digest
    or new.participant_id is distinct from old.participant_id
    or new.room_id is distinct from old.room_id then
    update public.backroom_android_native_bindings n
    set revoked_at=coalesce(n.revoked_at,v_now),expires_at=least(n.expires_at,v_now)
    from public.backroom_input_bindings b
    where n.binding_id=b.id and b.session_digest=old.session_digest and n.revoked_at is null;
    update public.backroom_android_native_binding_challenges c
    set revoked_at=coalesce(c.revoked_at,v_now),expires_at=least(c.expires_at,v_now)
    from public.backroom_input_bindings b
    where c.binding_id=b.id and b.session_digest=old.session_digest
      and c.consumed_at is null and c.revoked_at is null;
  elsif new.expires_at<old.expires_at then
    update public.backroom_android_native_bindings n
    set expires_at=least(n.expires_at,new.expires_at)
    from public.backroom_input_bindings b
    where n.binding_id=b.id and b.session_digest=old.session_digest and n.revoked_at is null;
    update public.backroom_android_native_binding_challenges c
    set expires_at=least(c.expires_at,new.expires_at)
    from public.backroom_input_bindings b
    where c.binding_id=b.id and b.session_digest=old.session_digest
      and c.consumed_at is null and c.revoked_at is null;
  end if;
  return new;
end;
$function$;
revoke all on function public.revoke_backroom_android_native_binding_on_mcp_session_change()
  from public,anon,authenticated;
grant execute on function public.revoke_backroom_android_native_binding_on_mcp_session_change() to service_role;
drop trigger if exists backroom_android_native_binding_mcp_session_lifecycle_trigger
  on public.rub_minds_mcp_sessions;
create trigger backroom_android_native_binding_mcp_session_lifecycle_trigger
after update of session_digest,terminated_at,expires_at,agent_credential_digest,participant_id,room_id
or delete on public.rub_minds_mcp_sessions
for each row execute function public.revoke_backroom_android_native_binding_on_mcp_session_change();

create or replace function public.register_backroom_android_native_binding(
  p_challenge_id uuid,p_nonce_digest text,p_device_id uuid,p_screen_session_id uuid,
  p_app_package_name text,p_app_signing_certificate_sha256 text,
  p_composer_identity_digest text,p_send_control_identity_digest text,
  p_provider_conversation_identity_digest text
)
returns jsonb
language plpgsql
security invoker
set search_path=''
as $function$
declare
  v_challenge public.backroom_android_native_binding_challenges%rowtype;
  v_binding public.backroom_input_bindings%rowtype;
  v_mcp public.rub_minds_mcp_sessions%rowtype;
  v_screen public.backroom_desktop_sessions%rowtype;
  v_device public.backroom_devices%rowtype;
  v_device_room_binding public.backroom_device_room_bindings%rowtype;
  v_app public.backroom_device_apps%rowtype;
  v_agent_connection public.agent_connections%rowtype;
  v_host public.backroom_hosts%rowtype;
  v_mapping public.backroom_android_native_bindings%rowtype;
  v_phone_mapping public.backroom_android_native_bindings%rowtype;
  v_now timestamptz:=pg_catalog.clock_timestamp();
  v_mapping_id uuid;
begin
  if p_challenge_id is null
    or p_nonce_digest is null or p_nonce_digest !~ '^[0-9a-f]{64}$'
    or p_device_id is null or p_screen_session_id is null
    or p_app_package_name is null
      or p_app_package_name !~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'
    or p_app_signing_certificate_sha256 is null
      or p_app_signing_certificate_sha256 !~ '^[0-9a-f]{64}(\.[0-9a-f]{64})*$'
    or p_composer_identity_digest is null or p_composer_identity_digest !~ '^[0-9a-f]{64}$'
    or p_send_control_identity_digest is null or p_send_control_identity_digest !~ '^[0-9a-f]{64}$'
    or p_provider_conversation_identity_digest is null
      or p_provider_conversation_identity_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid Android native binding evidence';
  end if;

  select * into v_challenge from public.backroom_android_native_binding_challenges c
  where c.id=p_challenge_id;
  if not found then return pg_catalog.jsonb_build_object('ok',false,'reason','challenge_not_found'); end if;
  if not exists(select 1 from public.rooms r
    where r.id=v_challenge.room_id and r.owner_id=v_challenge.owner_id) then
    return pg_catalog.jsonb_build_object('ok',false,'reason','room_owner_changed');
  end if;

  -- Lock order: session advisory -> MCP session -> group binding -> challenge -> screen -> device -> room pair -> app -> agent credential -> host -> native mapping.
  select * into v_binding from public.backroom_input_bindings b where b.id=v_challenge.binding_id;
  if not found then return pg_catalog.jsonb_build_object('ok',false,'reason','group_binding_not_found'); end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_binding.session_digest,0));
  select * into v_mcp from public.rub_minds_mcp_sessions s
  where s.session_digest=v_binding.session_digest for update;
  if not found or v_mcp.session_digest is distinct from v_binding.session_digest
    or v_mcp.terminated_at is not null or v_mcp.expires_at<=v_now
    or v_mcp.agent_credential_ciphertext is null
    or v_mcp.room_id is distinct from v_binding.room_id
    or v_mcp.participant_id is distinct from v_binding.participant_id then
    return pg_catalog.jsonb_build_object('ok',false,'reason','group_session_inactive');
  end if;

  select * into v_binding from public.backroom_input_bindings b
  where b.id=v_challenge.binding_id for update;
  if not found then return pg_catalog.jsonb_build_object('ok',false,'reason','group_binding_not_found'); end if;
  if v_mcp.session_digest is distinct from v_binding.session_digest
    or v_mcp.room_id is distinct from v_binding.room_id
    or v_mcp.participant_id is distinct from v_binding.participant_id then
    return pg_catalog.jsonb_build_object('ok',false,'reason','group_session_inactive');
  end if;

  select * into v_challenge from public.backroom_android_native_binding_challenges c
  where c.id=p_challenge_id for update;

  if not found then return pg_catalog.jsonb_build_object('ok',false,'reason','challenge_not_found'); end if;
  if v_challenge.binding_id is distinct from v_binding.id then
    return pg_catalog.jsonb_build_object('ok',false,'reason','group_binding_not_eligible');
  end if;
  if not exists(select 1 from public.rooms r
    where r.id=v_challenge.room_id and r.owner_id=v_challenge.owner_id) then
    return pg_catalog.jsonb_build_object('ok',false,'reason','room_owner_changed');
  end if;

  if v_binding.surface is distinct from 'android_app'
    or v_binding.revoked_at is not null
    or v_binding.owner_id is distinct from v_challenge.owner_id
    or v_binding.room_id is distinct from v_challenge.room_id
    or (v_binding.provider_conversation_identity_digest is not null
      and v_binding.provider_conversation_identity_digest is distinct from p_provider_conversation_identity_digest) then
    return pg_catalog.jsonb_build_object('ok',false,'reason','group_binding_not_eligible');
  end if;

  if not exists(select 1 from public.participants p
    where p.id=v_binding.participant_id and p.room_id=v_binding.room_id
      and p.kind in ('original_session','model','external_agent')
      and p.status in ('connected','active','autonomous')) then
    return pg_catalog.jsonb_build_object('ok',false,'reason','group_authorization_expired');
  end if;

  select * into v_screen from public.backroom_desktop_sessions s
  where s.session_id=p_screen_session_id and s.device_id=p_device_id
    and s.room_id=v_binding.room_id and s.requested_by=v_challenge.owner_id
    and s.session_type='screen' and s.status='active' and s.expires_at>v_now for update;
  if not found then return pg_catalog.jsonb_build_object('ok',false,'reason','screen_session_inactive'); end if;

  -- Lock every mutable device-side authority before writing an attestation.
  -- Revocation/app inventory updates therefore either happen before these checks
  -- or wait and revoke the newly inserted mapping after this transaction commits.
  select * into v_device from public.backroom_devices d
  where d.device_id=p_device_id and d.owner_id=v_challenge.owner_id
    and d.platform='android' and d.status='active'
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok',false,'reason','device_room_binding_inactive');
  end if;

  select * into v_device_room_binding from public.backroom_device_room_bindings rb
  where rb.device_id=p_device_id and rb.room_id=v_binding.room_id
    and rb.owner_id=v_challenge.owner_id and rb.revoked_at is null
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok',false,'reason','device_room_binding_inactive');
  end if;

  select * into v_app from public.backroom_device_apps a
  where a.device_id=p_device_id and a.package_name=p_app_package_name
    and a.signing_certificate_sha256=p_app_signing_certificate_sha256
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok',false,'reason','app_signer_not_in_device_inventory');
  end if;

  select * into v_agent_connection from public.agent_connections ac
  where ac.credential_digest=v_mcp.agent_credential_digest
    and ac.owner_id=v_binding.owner_id and ac.room_id=v_binding.room_id
    and ac.participant_id=v_binding.participant_id
    and ac.revoked_at is null and ac.expires_at>v_now
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok',false,'reason','group_authorization_expired');
  end if;

  select * into v_host from public.backroom_hosts h
  where h.host_id=v_binding.host_id and h.owner_id=v_binding.owner_id
    and h.revoked_at is null and h.expires_at>v_now
  for update;
  if not found then
    return pg_catalog.jsonb_build_object('ok',false,'reason','group_authorization_expired');
  end if;

  -- Recheck after acquiring every mutable authority lock; waits must not make
  -- a previously live challenge valid beyond an expired underlying lease.
  v_now:=pg_catalog.clock_timestamp();
  if v_challenge.revoked_at is not null or v_challenge.expires_at<=v_now then
    return pg_catalog.jsonb_build_object('ok',false,'reason','challenge_invalid_or_expired');
  end if;
  if v_mcp.terminated_at is not null or v_mcp.expires_at<=v_now
    or v_screen.status is distinct from 'active' or v_screen.expires_at<=v_now
    or v_device.status is distinct from 'active'
    or v_agent_connection.revoked_at is not null or v_agent_connection.expires_at<=v_now
    or v_host.revoked_at is not null or v_host.expires_at<=v_now then
    return pg_catalog.jsonb_build_object('ok',false,'reason','group_authorization_expired');
  end if;

  -- Replays are acknowledged only after the live MCP, group, screen, device,
  -- room pairing, app signer and host authorities have been locked and checked.
  -- This closes the race where a consumed challenge could report success after
  -- its screen/device mapping had already been revoked.
  if v_challenge.consumed_at is not null then
    select * into v_mapping from public.backroom_android_native_bindings n
    where n.binding_id=v_challenge.binding_id and n.revoked_at is null
    order by n.attested_at desc limit 1;
    if found
      and v_challenge.nonce_digest is not distinct from p_nonce_digest
      and v_challenge.device_id is not distinct from p_device_id
      and v_challenge.screen_session_id is not distinct from p_screen_session_id
      and v_challenge.app_package_name is not distinct from p_app_package_name
      and v_challenge.revoked_at is null
      and v_mapping.device_id=p_device_id
      and v_mapping.screen_session_id=p_screen_session_id
      and v_mapping.app_package_name=p_app_package_name
      and v_mapping.app_signing_certificate_sha256=p_app_signing_certificate_sha256
      and v_mapping.composer_identity_digest=p_composer_identity_digest
      and v_mapping.send_control_identity_digest=p_send_control_identity_digest
      and v_mapping.provider_conversation_identity_digest=p_provider_conversation_identity_digest
      and v_mapping.expires_at>v_now then
      return pg_catalog.jsonb_build_object('ok',true,'nativeBindingId',v_mapping.id,
        'bindingId',v_mapping.binding_id,'expiresAt',v_mapping.expires_at,'replayed',true);
    end if;
    return pg_catalog.jsonb_build_object('ok',false,'reason','challenge_already_consumed');
  end if;

  if v_challenge.revoked_at is not null or v_challenge.expires_at<=v_now
    or v_challenge.nonce_digest is distinct from p_nonce_digest
    or v_challenge.device_id is distinct from p_device_id
    or v_challenge.screen_session_id is distinct from p_screen_session_id
    or v_challenge.app_package_name is distinct from p_app_package_name
    or v_challenge.room_id is distinct from v_binding.room_id
    or v_challenge.owner_id is distinct from v_binding.owner_id then
    return pg_catalog.jsonb_build_object('ok',false,'reason','challenge_invalid_or_expired');
  end if;

  if v_binding.surface is distinct from 'android_app'
    or v_binding.revoked_at is not null or v_binding.wake_enabled
    or (v_binding.provider_conversation_identity_digest is not null
      and v_binding.provider_conversation_identity_digest is distinct from p_provider_conversation_identity_digest)
    or exists(select 1 from public.backroom_wake_jobs j where j.binding_id=v_binding.id) then
    return pg_catalog.jsonb_build_object('ok',false,'reason','group_binding_not_eligible');
  end if;

  select * into v_mapping from public.backroom_android_native_bindings n
  where n.binding_id=v_binding.id and n.revoked_at is null for update;
  if found and v_mapping.expires_at>v_now then
    if v_mapping.device_id=p_device_id and v_mapping.screen_session_id=p_screen_session_id
      and v_mapping.app_package_name=p_app_package_name
      and v_mapping.app_signing_certificate_sha256=p_app_signing_certificate_sha256
      and v_mapping.composer_identity_digest=p_composer_identity_digest
      and v_mapping.send_control_identity_digest=p_send_control_identity_digest
      and v_mapping.provider_conversation_identity_digest=p_provider_conversation_identity_digest then
      update public.backroom_android_native_binding_challenges set consumed_at=v_now where id=p_challenge_id;
      return pg_catalog.jsonb_build_object('ok',true,'nativeBindingId',v_mapping.id,
        'bindingId',v_binding.id,'expiresAt',v_mapping.expires_at,'replayed',true);
    end if;
    return pg_catalog.jsonb_build_object('ok',false,'reason','native_binding_already_active');
  elsif found then
    update public.backroom_android_native_bindings set revoked_at=coalesce(revoked_at,v_now)
    where id=v_mapping.id;
  end if;

  -- The same live Android screen may serve only one group binding. Retire an
  -- expired mapping on that screen before inserting a different group binding.
  select * into v_phone_mapping from public.backroom_android_native_bindings n
  where n.device_id=p_device_id and n.screen_session_id=p_screen_session_id
    and n.revoked_at is null for update;
  if found and v_phone_mapping.id is distinct from v_mapping.id then
    if v_phone_mapping.expires_at>v_now then
      return pg_catalog.jsonb_build_object('ok',false,'reason','phone_screen_already_bound');
    end if;
    update public.backroom_android_native_bindings
    set revoked_at=coalesce(revoked_at,v_now)
    where id=v_phone_mapping.id;
  end if;

  insert into public.backroom_android_native_bindings(
    challenge_id,binding_id,owner_id,room_id,participant_id,device_id,screen_session_id,
    app_package_name,app_signing_certificate_sha256,composer_identity_digest,
    send_control_identity_digest,provider_conversation_identity_digest,expires_at
  ) values(
    p_challenge_id,v_binding.id,v_binding.owner_id,v_binding.room_id,v_binding.participant_id,
    p_device_id,p_screen_session_id,p_app_package_name,p_app_signing_certificate_sha256,
    p_composer_identity_digest,p_send_control_identity_digest,p_provider_conversation_identity_digest,
    least(v_screen.expires_at,v_mcp.expires_at,v_agent_connection.expires_at,
      v_host.expires_at,v_now+interval '15 minutes')
  ) returning id into v_mapping_id;

  if v_binding.provider_conversation_identity_digest is null then
    update public.backroom_input_bindings
    set provider_conversation_identity_digest=p_provider_conversation_identity_digest,updated_at=v_now
    where id=v_binding.id and provider_conversation_identity_digest is null;
    if not found then raise exception 'Provider identity changed during native binding registration'; end if;
  end if;

  update public.backroom_android_native_binding_challenges set consumed_at=v_now
  where id=p_challenge_id and consumed_at is null and revoked_at is null;
  if not found then raise exception 'Android native binding challenge was consumed concurrently'; end if;
  return pg_catalog.jsonb_build_object('ok',true,'nativeBindingId',v_mapping_id,
    'bindingId',v_binding.id,'expiresAt',least(v_screen.expires_at,v_mcp.expires_at,
      v_agent_connection.expires_at,v_host.expires_at,v_now+interval '15 minutes'),'replayed',false);
end;
$function$;

revoke all on function public.register_backroom_android_native_binding(
  uuid,text,uuid,uuid,text,text,text,text,text
) from public,anon,authenticated;
grant execute on function public.register_backroom_android_native_binding(
  uuid,text,uuid,uuid,text,text,text,text,text
) to service_role;

comment on table public.backroom_android_native_bindings is
  'Device-bearer-authenticated native mapping from a group binding to an exact Android screen, app signer, composer, Send control and provider conversation.';
comment on table public.backroom_android_native_binding_challenges is
  'Short-lived owner-approved one-time challenges; the database stores only the nonce digest.';
