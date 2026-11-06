-- Device-bearer-authenticated attestation for the phone-local provider conversation identity.
-- Only the Android companion can register these digests. The owner/browser host API
-- must not accept or return provider-conversation identity material.

create table if not exists public.backroom_android_native_binding_attestations (
  binding_id uuid primary key references public.backroom_input_bindings(id) on delete cascade,
  device_id uuid not null references public.backroom_devices(device_id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  screen_session_id uuid not null references public.backroom_desktop_sessions(session_id) on delete cascade,
  app_package_name text not null
    check (app_package_name ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'),
  app_signer_digest text not null check (app_signer_digest ~ '^[a-f0-9]{64}$'),
  composer_identity_digest text not null check (composer_identity_digest ~ '^[a-f0-9]{64}$'),
  send_control_identity_digest text not null check (send_control_identity_digest ~ '^[a-f0-9]{64}$'),
  provider_conversation_identity_digest text not null
    check (provider_conversation_identity_digest ~ '^[a-f0-9]{64}$'),
  attested_at timestamptz not null default pg_catalog.clock_timestamp(),
  revoked_at timestamptz
);

alter table public.backroom_android_native_binding_attestations enable row level security;
revoke all on table public.backroom_android_native_binding_attestations from public, anon, authenticated;
revoke insert, update, delete on table public.backroom_android_native_binding_attestations from service_role;
grant select on table public.backroom_android_native_binding_attestations to service_role;

create unique index if not exists backroom_android_native_attestation_active_target_idx
  on public.backroom_android_native_binding_attestations(device_id,screen_session_id,app_package_name)
  where revoked_at is null;
create index if not exists backroom_android_native_attestation_device_idx
  on public.backroom_android_native_binding_attestations(device_id,screen_session_id)
  where revoked_at is null;

comment on table public.backroom_android_native_binding_attestations is
  'Service-role-readable, device-bearer-written attestation linking one Android screen session and app target to a group input binding. Stores opaque SHA-256 digests only; raw provider IDs and content remain on device.';

-- Earlier source branches allowed an owner-authenticated browser request to populate the
-- provider digest. Those values are not device-attested. Clear them and cancel native
-- queued work before installing the device-only write gate. Composer bindings remain
-- registered for manual draft use and can be attested again from an approved phone.
drop trigger if exists backroom_binding_provider_identity_immutable_trigger
  on public.backroom_input_bindings;
drop trigger if exists backroom_wake_job_provider_identity_trigger
  on public.backroom_wake_jobs;

update public.backroom_wake_jobs j
set state='cancelled',
    lease_owner=null,
    lease_token_hash=null,
    lease_expires_at=null,
    provider_conversation_identity_digest=null,
    last_error_code='authorization_denied',
    updated_at=pg_catalog.clock_timestamp()
from public.backroom_input_bindings b
where b.id=j.binding_id
  and b.surface='android_app'
  and j.state in ('pending','leased');

update public.backroom_input_bindings b
set wake_last_revoked_grant_id=b.wake_grant_id,
    wake_enabled=false,
    wake_grant_id=null,
    confirmed_at=null,
    wake_expires_at=null,
    provider_conversation_identity_digest=null,
    updated_at=pg_catalog.clock_timestamp()
where b.surface='android_app';

create or replace function public.guard_backroom_input_binding_provider_identity()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
begin
  if new.provider_conversation_identity_digest is distinct from old.provider_conversation_identity_digest then
    if old.provider_conversation_identity_digest is not null
      or new.provider_conversation_identity_digest is null
      or new.provider_conversation_identity_digest !~ '^[a-f0-9]{64}$'
      or new.surface <> 'android_app'
      or not exists (
        select 1
        from public.backroom_android_native_binding_attestations a
        join public.backroom_devices d on d.device_id=a.device_id
        join public.backroom_device_room_bindings rb
          on rb.device_id=a.device_id and rb.room_id=a.room_id
        join public.backroom_desktop_sessions s
          on s.session_id=a.screen_session_id and s.device_id=a.device_id and s.room_id=a.room_id
        join public.backroom_device_apps app
          on app.device_id=a.device_id and app.package_name=a.app_package_name
        where a.binding_id=new.id
          and a.room_id=new.room_id
          and a.provider_conversation_identity_digest=new.provider_conversation_identity_digest
          and a.revoked_at is null
          and d.owner_id=new.owner_id and d.status='active' and d.platform='android'
          and rb.owner_id=new.owner_id and rb.revoked_at is null
          and s.session_type='screen' and s.status='active' and s.expires_at>pg_catalog.clock_timestamp()
          and a.app_signer_digest = any(pg_catalog.string_to_array(app.signing_certificate_sha256,'.'))
      ) then
      raise check_violation using
        message = 'Provider conversation identity can only be initialized from an active device-bearer attestation';
    end if;
  end if;
  return new;
end;
$function$;

revoke all on function public.guard_backroom_input_binding_provider_identity()
  from public,anon,authenticated,service_role;
drop trigger if exists backroom_binding_provider_identity_immutable_trigger
  on public.backroom_input_bindings;
create trigger backroom_binding_provider_identity_immutable_trigger
before update of provider_conversation_identity_digest on public.backroom_input_bindings
for each row execute function public.guard_backroom_input_binding_provider_identity();

-- Native wake consent cannot be activated by the generic host API. The exact active
-- device/screen/app attestation must already exist for this immutable binding.
create or replace function public.guard_backroom_android_native_wake_activation()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
begin
  if new.surface='android_app' and new.wake_enabled=true and
    (old.wake_enabled is distinct from true) then
    if new.provider_conversation_identity_digest is null or not exists (
      select 1
      from public.backroom_android_native_binding_attestations a
      join public.backroom_devices d on d.device_id=a.device_id
      join public.backroom_device_room_bindings rb
        on rb.device_id=a.device_id and rb.room_id=a.room_id
      join public.backroom_desktop_sessions s
        on s.session_id=a.screen_session_id and s.device_id=a.device_id and s.room_id=a.room_id
      join public.backroom_device_apps app
        on app.device_id=a.device_id and app.package_name=a.app_package_name
      where a.binding_id=new.id
        and a.room_id=new.room_id
        and a.provider_conversation_identity_digest=new.provider_conversation_identity_digest
        and a.revoked_at is null
        and d.owner_id=new.owner_id and d.status='active' and d.platform='android'
        and rb.owner_id=new.owner_id and rb.revoked_at is null
        and s.session_type='screen' and s.status='active' and s.expires_at>pg_catalog.clock_timestamp()
        and a.app_signer_digest = any(pg_catalog.string_to_array(app.signing_certificate_sha256,'.'))
    ) then
      raise check_violation using
        message = 'Android native wake requires a live device, screen, app and provider-conversation attestation';
    end if;
  end if;
  return new;
end;
$function$;

revoke all on function public.guard_backroom_android_native_wake_activation()
  from public,anon,authenticated,service_role;
drop trigger if exists backroom_android_native_wake_activation_guard
  on public.backroom_input_bindings;
create trigger backroom_android_native_wake_activation_guard
before update of wake_enabled on public.backroom_input_bindings
for each row execute function public.guard_backroom_android_native_wake_activation();

-- This is the only write RPC for the attestation table. Its caller is the
-- backroom-device Edge Function after authenticating the device bearer and
-- independently validating the active room, screen session and app signer.
create or replace function public.register_backroom_android_native_binding(
  p_binding_id uuid,
  p_device_id uuid,
  p_room_id uuid,
  p_screen_session_id uuid,
  p_app_package_name text,
  p_app_signer_digest text,
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
  v_device public.backroom_devices%rowtype;
  v_session public.backroom_desktop_sessions%rowtype;
  v_app public.backroom_device_apps%rowtype;
begin
  if p_binding_id is null or p_device_id is null or p_room_id is null
    or p_screen_session_id is null
    or p_app_package_name is null
    or p_app_package_name !~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'
    or p_app_signer_digest is null or p_app_signer_digest !~ '^[a-f0-9]{64}$'
    or p_composer_identity_digest is null or p_composer_identity_digest !~ '^[a-f0-9]{64}$'
    or p_send_control_identity_digest is null or p_send_control_identity_digest !~ '^[a-f0-9]{64}$'
    or p_provider_conversation_identity_digest is null
    or p_provider_conversation_identity_digest !~ '^[a-f0-9]{64}$' then
    return false;
  end if;

  select * into v_binding
  from public.backroom_input_bindings b
  where b.id=p_binding_id
  for update;
  if not found or v_binding.surface<>'android_app'
    or v_binding.room_id<>p_room_id
    or v_binding.revoked_at is not null
    or v_binding.wake_enabled=true then
    return false;
  end if;

  -- An exact retry after a lost HTTP response is idempotent; a changed device,
  -- session, app or digest must use a newly registered group binding.
  if exists (
    select 1 from public.backroom_android_native_binding_attestations a
    where a.binding_id=p_binding_id
  ) then
    return exists (
      select 1 from public.backroom_android_native_binding_attestations a
      where a.binding_id=p_binding_id and a.device_id=p_device_id
        and a.room_id=p_room_id and a.screen_session_id=p_screen_session_id
        and a.app_package_name=p_app_package_name
        and a.app_signer_digest=p_app_signer_digest
        and a.composer_identity_digest=p_composer_identity_digest
        and a.send_control_identity_digest=p_send_control_identity_digest
        and a.provider_conversation_identity_digest=p_provider_conversation_identity_digest
        and a.revoked_at is null
      ) and v_binding.provider_conversation_identity_digest=p_provider_conversation_identity_digest;
  end if;

  select * into v_device
  from public.backroom_devices d
  where d.device_id=p_device_id
  for share;
  if not found or v_device.status<>'active' or v_device.platform<>'android'
    or v_device.owner_id<>v_binding.owner_id then
    return false;
  end if;

  if not exists (
    select 1 from public.backroom_device_room_bindings rb
    where rb.device_id=p_device_id and rb.room_id=p_room_id
      and rb.owner_id=v_binding.owner_id and rb.revoked_at is null
  ) then return false; end if;

  select * into v_session
  from public.backroom_desktop_sessions s
  where s.session_id=p_screen_session_id and s.device_id=p_device_id
    and s.room_id=p_room_id and s.session_type='screen'
    and s.status='active' and s.expires_at>pg_catalog.clock_timestamp()
  for share;
  if not found then return false; end if;

  select * into v_app
  from public.backroom_device_apps app
  where app.device_id=p_device_id and app.package_name=p_app_package_name
  for share;
  if not found or not (p_app_signer_digest = any(pg_catalog.string_to_array(v_app.signing_certificate_sha256,'.'))) then
    return false;
  end if;

  if not exists (
    select 1
    from public.backroom_hosts h
    where h.host_id=v_binding.host_id and h.owner_id=v_binding.owner_id
      and h.revoked_at is null and h.expires_at>pg_catalog.clock_timestamp()
  ) or not exists (
    select 1
    from public.rub_minds_mcp_sessions s
    join public.participants p on p.id=s.participant_id and p.room_id=s.room_id
    join public.agent_connections c on c.room_id=p.room_id and c.participant_id=p.id
      and c.owner_id=v_binding.owner_id and c.revoked_at is null
      and c.expires_at>pg_catalog.clock_timestamp()
    where s.session_digest=v_binding.session_digest
      and s.room_id=v_binding.room_id and s.participant_id=v_binding.participant_id
      and s.terminated_at is null and s.expires_at>pg_catalog.clock_timestamp()
      and s.agent_credential_ciphertext is not null
      and p.status in ('connected','active','autonomous')
      and p.kind in ('original_session','model','external_agent')
  ) then return false; end if;

  if exists (
    select 1 from public.backroom_android_native_binding_attestations a
    where a.device_id=p_device_id and a.screen_session_id=p_screen_session_id
      and a.app_package_name=p_app_package_name and a.revoked_at is null
  ) then return false; end if;

  insert into public.backroom_android_native_binding_attestations(
    binding_id,device_id,room_id,screen_session_id,app_package_name,
    app_signer_digest,composer_identity_digest,send_control_identity_digest,
    provider_conversation_identity_digest
  ) values (
    p_binding_id,p_device_id,p_room_id,p_screen_session_id,p_app_package_name,
    p_app_signer_digest,p_composer_identity_digest,p_send_control_identity_digest,
    p_provider_conversation_identity_digest
  );

  update public.backroom_input_bindings b
  set provider_conversation_identity_digest=p_provider_conversation_identity_digest,
      updated_at=pg_catalog.clock_timestamp()
  where b.id=p_binding_id and b.provider_conversation_identity_digest is null
    and b.wake_enabled=false and b.revoked_at is null;

  if not found then
    raise exception 'Android native binding changed during attestation';
  end if;
  return true;
end;
$function$;

revoke all on function public.register_backroom_android_native_binding(
  uuid,uuid,uuid,uuid,text,text,text,text,text
) from public,anon,authenticated;
grant execute on function public.register_backroom_android_native_binding(
  uuid,uuid,uuid,uuid,text,text,text,text,text
) to service_role;

-- Cancel a device-attested binding and all work when its selected screen target,
-- device or room grant is revoked. Manual draft enrollment remains available via
-- a new input binding and a fresh local selection.
create or replace function public.invalidate_backroom_android_native_binding()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
begin
  if old.revoked_at is null and new.revoked_at is not null then
    update public.backroom_android_native_binding_attestations a
    set revoked_at=coalesce(a.revoked_at,pg_catalog.clock_timestamp())
    where a.binding_id=new.id and a.revoked_at is null;

    update public.backroom_input_bindings b
    set wake_last_revoked_grant_id=b.wake_grant_id,
        wake_enabled=false,wake_grant_id=null,confirmed_at=null,wake_expires_at=null,
        updated_at=pg_catalog.clock_timestamp()
    where b.id=new.id and b.wake_enabled=true;

    update public.backroom_wake_jobs j
    set state='cancelled',lease_owner=null,lease_token_hash=null,lease_expires_at=null,
        last_error_code='authorization_denied',updated_at=pg_catalog.clock_timestamp()
    where j.binding_id=new.id and j.state in ('pending','leased');
  end if;
  return null;
end;
$function$;

revoke all on function public.invalidate_backroom_android_native_binding()
  from public,anon,authenticated,service_role;
drop trigger if exists backroom_android_native_binding_invalidate_on_binding_revoke
  on public.backroom_input_bindings;
create trigger backroom_android_native_binding_invalidate_on_binding_revoke
after update of revoked_at on public.backroom_input_bindings
for each row execute function public.invalidate_backroom_android_native_binding();

create or replace function public.invalidate_backroom_android_binding_on_screen_close()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
begin
  if old.status='active' and (new.status<>'active' or new.expires_at<=pg_catalog.clock_timestamp()) then
    update public.backroom_input_bindings b
    set revoked_at=coalesce(b.revoked_at,pg_catalog.clock_timestamp())
    where b.id in (
      select a.binding_id from public.backroom_android_native_binding_attestations a
      where a.screen_session_id=new.session_id and a.device_id=new.device_id
        and a.revoked_at is null
    ) and b.revoked_at is null;
  end if;
  return null;
end;
$function$;

revoke all on function public.invalidate_backroom_android_binding_on_screen_close()
  from public,anon,authenticated,service_role;
drop trigger if exists backroom_android_native_binding_screen_close
  on public.backroom_desktop_sessions;
create trigger backroom_android_native_binding_screen_close
after update of status,expires_at on public.backroom_desktop_sessions
for each row execute function public.invalidate_backroom_android_binding_on_screen_close();

create or replace function public.invalidate_backroom_android_binding_on_device_revoke()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
begin
  if old.status='active' and new.status<>'active' then
    update public.backroom_input_bindings b
    set revoked_at=coalesce(b.revoked_at,pg_catalog.clock_timestamp())
    where b.id in (
      select a.binding_id from public.backroom_android_native_binding_attestations a
      where a.device_id=new.device_id and a.revoked_at is null
    ) and b.revoked_at is null;
  end if;
  return null;
end;
$function$;

revoke all on function public.invalidate_backroom_android_binding_on_device_revoke()
  from public,anon,authenticated,service_role;
drop trigger if exists backroom_android_native_binding_device_revoke
  on public.backroom_devices;
create trigger backroom_android_native_binding_device_revoke
after update of status on public.backroom_devices
for each row execute function public.invalidate_backroom_android_binding_on_device_revoke();

create or replace function public.invalidate_backroom_android_binding_on_room_revoke()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
begin
  if old.revoked_at is null and new.revoked_at is not null then
    update public.backroom_input_bindings b
    set revoked_at=coalesce(b.revoked_at,pg_catalog.clock_timestamp())
    where b.id in (
      select a.binding_id from public.backroom_android_native_binding_attestations a
      where a.device_id=new.device_id and a.room_id=new.room_id and a.revoked_at is null
    ) and b.revoked_at is null;
  end if;
  return null;
end;
$function$;

revoke all on function public.invalidate_backroom_android_binding_on_room_revoke()
  from public,anon,authenticated,service_role;
drop trigger if exists backroom_android_native_binding_room_revoke
  on public.backroom_device_room_bindings;
create trigger backroom_android_native_binding_room_revoke
after update of revoked_at on public.backroom_device_room_bindings
for each row execute function public.invalidate_backroom_android_binding_on_room_revoke();

-- A queued Android native wake is eligible only when its exact binding still has
-- the same live attestation and active device/session/app. Browser jobs are unchanged.
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
    raise check_violation using message = 'Backroom wake job does not match an exact registered input binding';
  end if;
  if new.provider_conversation_identity_digest is not null
    and new.provider_conversation_identity_digest is distinct from v_binding.provider_conversation_identity_digest then
    raise check_violation using message = 'Backroom wake provider-conversation digest does not match its binding';
  end if;
  if v_binding.surface in ('desktop_app','windows_app','android_app')
    and v_binding.provider_conversation_identity_digest is null then
    raise check_violation using message = 'Native wake requires a registered provider-conversation identity digest';
  end if;
  if v_binding.surface='android_app' and not exists (
    select 1
    from public.backroom_android_native_binding_attestations a
    join public.backroom_devices d on d.device_id=a.device_id
    join public.backroom_device_room_bindings rb
      on rb.device_id=a.device_id and rb.room_id=a.room_id
    join public.backroom_desktop_sessions s
      on s.session_id=a.screen_session_id and s.device_id=a.device_id and s.room_id=a.room_id
    join public.backroom_device_apps app
      on app.device_id=a.device_id and app.package_name=a.app_package_name
    where a.binding_id=v_binding.id and a.room_id=v_binding.room_id
      and a.provider_conversation_identity_digest=v_binding.provider_conversation_identity_digest
      and a.revoked_at is null
      and d.owner_id=v_binding.owner_id and d.status='active' and d.platform='android'
      and rb.owner_id=v_binding.owner_id and rb.revoked_at is null
      and s.session_type='screen' and s.status='active' and s.expires_at>pg_catalog.clock_timestamp()
      and a.app_signer_digest=any(pg_catalog.string_to_array(app.signing_certificate_sha256,'.'))
  ) then
    raise check_violation using message = 'Android native wake requires a current device-bearer attestation';
  end if;
  new.provider_conversation_identity_digest:=v_binding.provider_conversation_identity_digest;
  return new;
end;
$function$;

revoke all on function public.sync_backroom_wake_job_provider_identity()
  from public,anon,authenticated;
grant execute on function public.sync_backroom_wake_job_provider_identity() to service_role;

drop trigger if exists backroom_wake_job_provider_identity_trigger on public.backroom_wake_jobs;
create trigger backroom_wake_job_provider_identity_trigger
before insert or update of binding_id, owner_id, room_id, participant_id, host_id,
  session_digest, space_id, session_id, target_id, target_identity_fingerprint,
  target_revision, provider_conversation_identity_digest
on public.backroom_wake_jobs
for each row execute function public.sync_backroom_wake_job_provider_identity();
