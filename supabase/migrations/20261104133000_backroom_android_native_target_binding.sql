-- Device-attested Android target binding.
-- This migration registers a phone's exact selected app/composer/Send/provider
-- identity against an owner-created group AI/MCP binding. It does NOT forward
-- group wake jobs to the handset; native wake activation remains fail-closed.

-- Give an approved Android device a server-side host identity whose credential
-- digest is the same opaque device-token digest already stored by the device table.
create or replace function public.sync_backroom_device_host_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.status = 'active' and old.status is distinct from 'active' then
    insert into public.backroom_hosts(host_id,owner_id,credential_digest,expires_at)
    values (
      new.device_id::text,
      new.owner_id,
      new.token_digest,
      pg_catalog.clock_timestamp() + interval '30 days'
    )
    on conflict (host_id) do nothing;

    if not exists (
      select 1
      from public.backroom_hosts h
      where h.host_id = new.device_id::text
        and h.owner_id = new.owner_id
        and h.credential_digest = new.token_digest
        and h.revoked_at is null
    ) then
      raise exception 'Android device host identity conflicts with an existing host';
    end if;
  elsif new.status = 'revoked' and old.status is distinct from 'revoked' then
    -- The existing host revoke routine cancels queued work and revokes every
    -- group input binding attached to this physical device host.
    perform public.revoke_backroom_host(new.device_id::text,new.owner_id);
  end if;
  return new;
end;
$function$;

revoke all on function public.sync_backroom_device_host_identity()
  from public,anon,authenticated;
grant execute on function public.sync_backroom_device_host_identity()
  to service_role;

drop trigger if exists backroom_device_host_identity_trigger on public.backroom_devices;
create trigger backroom_device_host_identity_trigger
after update of status on public.backroom_devices
for each row
execute function public.sync_backroom_device_host_identity();

-- Devices approved before this migration also receive the matching host record.
insert into public.backroom_hosts(host_id,owner_id,credential_digest,expires_at)
select d.device_id::text,d.owner_id,d.token_digest,
       pg_catalog.clock_timestamp() + interval '30 days'
from public.backroom_devices d
where d.status = 'active'
on conflict (host_id) do nothing;

do $verify_device_hosts$
begin
  if exists (
    select 1
    from public.backroom_devices d
    left join public.backroom_hosts h
      on h.host_id = d.device_id::text
     and h.owner_id = d.owner_id
     and h.credential_digest = d.token_digest
     and h.revoked_at is null
    where d.status = 'active'
      and h.host_id is null
  ) then
    raise exception 'One or more active Android devices could not be provisioned as a Backroom host';
  end if;
end;
$verify_device_hosts$;

create table if not exists public.backroom_android_native_targets (
  binding_id uuid primary key
    references public.backroom_input_bindings(id) on delete cascade,
  device_id uuid not null
    references public.backroom_devices(device_id) on delete cascade,
  room_id uuid not null
    references public.rooms(id) on delete cascade,
  screen_session_id uuid not null
    references public.backroom_desktop_sessions(session_id) on delete cascade,
  app_package_name text not null
    check (app_package_name ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'),
  app_signer_sha256 text not null
    check (app_signer_sha256 ~ '^[a-f0-9]{64}(\.[a-f0-9]{64})*$'),
  composer_identity_digest text not null
    check (composer_identity_digest ~ '^[a-f0-9]{64}$'),
  send_control_identity_digest text not null
    check (send_control_identity_digest ~ '^[a-f0-9]{64}$'),
  provider_conversation_identity_digest text not null
    check (provider_conversation_identity_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  revoked_at timestamptz
);

alter table public.backroom_android_native_targets enable row level security;
revoke all on table public.backroom_android_native_targets from public,anon,authenticated;
grant select,insert,update,delete on table public.backroom_android_native_targets to service_role;

create unique index if not exists backroom_android_native_target_one_active_per_device_idx
  on public.backroom_android_native_targets(device_id)
  where revoked_at is null;
create index if not exists backroom_android_native_targets_room_session_idx
  on public.backroom_android_native_targets(room_id,screen_session_id)
  where revoked_at is null;

comment on table public.backroom_android_native_targets is
  'Service-role-only device-attested mapping from one owner-created Android group binding to the exact paired device, active screen session, app signer, composer, Send control and provider-conversation digests. Does not itself enable native wake.';

create or replace function public.revoke_backroom_android_target_with_binding()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.revoked_at is not null and old.revoked_at is null then
    update public.backroom_android_native_targets
    set revoked_at = pg_catalog.clock_timestamp()
    where binding_id = new.id and revoked_at is null;
  end if;
  return new;
end;
$function$;

revoke all on function public.revoke_backroom_android_target_with_binding()
  from public,anon,authenticated;
grant execute on function public.revoke_backroom_android_target_with_binding()
  to service_role;

drop trigger if exists backroom_android_target_revoke_with_binding_trigger
  on public.backroom_input_bindings;
create trigger backroom_android_target_revoke_with_binding_trigger
after update of revoked_at on public.backroom_input_bindings
for each row
execute function public.revoke_backroom_android_target_with_binding();

-- Called only by the service-role Edge Function after the phone has re-resolved
-- the current provider conversation and submitted the proof using its device bearer.
-- The group binding itself must already have been created by the authenticated owner.
create or replace function public.register_backroom_android_native_target(
  p_device_id uuid,
  p_binding_id uuid,
  p_room_id uuid,
  p_screen_session_id uuid,
  p_app_package_name text,
  p_composer_identity_digest text,
  p_send_control_identity_digest text,
  p_provider_conversation_identity_digest text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_device public.backroom_devices%rowtype;
  v_binding public.backroom_input_bindings%rowtype;
  v_app public.backroom_device_apps%rowtype;
  v_existing public.backroom_android_native_targets%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_device_id is null or p_binding_id is null or p_room_id is null
    or p_screen_session_id is null
    or p_app_package_name is null
    or p_app_package_name !~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'
    or p_composer_identity_digest is null
    or p_composer_identity_digest !~ '^[a-f0-9]{64}$'
    or p_send_control_identity_digest is null
    or p_send_control_identity_digest !~ '^[a-f0-9]{64}$'
    or p_provider_conversation_identity_digest is null
    or p_provider_conversation_identity_digest !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid Android native target attestation';
  end if;

  select * into v_device
  from public.backroom_devices d
  where d.device_id = p_device_id and d.status = 'active'
  for update;
  if not found then return false; end if;

  if not exists (
    select 1 from public.backroom_device_room_bindings rb
    where rb.device_id = p_device_id
      and rb.room_id = p_room_id
      and rb.owner_id = v_device.owner_id
      and rb.revoked_at is null
  ) or not exists (
    select 1 from public.rooms r
    where r.id = p_room_id and r.owner_id = v_device.owner_id
  ) then
    return false;
  end if;

  if not exists (
    select 1 from public.backroom_hosts h
    where h.host_id = p_device_id::text
      and h.owner_id = v_device.owner_id
      and h.credential_digest = v_device.token_digest
      and h.revoked_at is null
      and h.expires_at > v_now
  ) then
    return false;
  end if;

  if not exists (
    select 1 from public.backroom_desktop_sessions s
    where s.session_id = p_screen_session_id
      and s.device_id = p_device_id
      and s.room_id = p_room_id
      and s.session_type = 'screen'
      and s.status = 'active'
      and s.expires_at > v_now
  ) then
    return false;
  end if;

  select * into v_app
  from public.backroom_device_apps a
  where a.device_id = p_device_id
    and a.package_name = p_app_package_name
    and a.draft_insertion_allowed = true;
  if not found then return false; end if;

  select * into v_binding
  from public.backroom_input_bindings b
  where b.id = p_binding_id
    and b.owner_id = v_device.owner_id
    and b.room_id = p_room_id
    and b.host_id = p_device_id::text
    and b.session_id = p_screen_session_id::text
    and b.space_id = 'android-device:' || p_device_id::text
    and b.surface = 'android_app'
    and b.locator_kind = 'accessibility'
    and b.target_id = p_composer_identity_digest
    and b.target_identity_fingerprint = v_app.signing_certificate_sha256
    and b.provider_conversation_identity_digest = p_provider_conversation_identity_digest
    and b.revoked_at is null
  for update;
  if not found then return false; end if;

  if not exists (
    select 1 from public.participants p
    where p.id = v_binding.participant_id and p.room_id = v_binding.room_id
      and p.kind in ('original_session','model','external_agent')
      and p.status in ('connected','active','autonomous')
  ) then return false; end if;

  if not exists (
    select 1 from public.agent_connections ac
    where ac.room_id = v_binding.room_id
      and ac.participant_id = v_binding.participant_id
      and ac.owner_id = v_binding.owner_id
      and ac.revoked_at is null and ac.expires_at > v_now
  ) then return false; end if;

  if not exists (
    select 1 from public.rub_minds_mcp_sessions ms
    where ms.session_digest = v_binding.session_digest
      and ms.room_id = v_binding.room_id
      and ms.participant_id = v_binding.participant_id
      and ms.terminated_at is null and ms.expires_at > v_now
      and ms.agent_credential_ciphertext is not null
  ) then return false; end if;

  select * into v_existing
  from public.backroom_android_native_targets t
  where (t.binding_id = p_binding_id or t.device_id = p_device_id)
    and t.revoked_at is null
  for update;

  if found then
    return v_existing.binding_id = p_binding_id
      and v_existing.device_id = p_device_id
      and v_existing.room_id = p_room_id
      and v_existing.screen_session_id = p_screen_session_id
      and v_existing.app_package_name = p_app_package_name
      and v_existing.app_signer_sha256 = v_app.signing_certificate_sha256
      and v_existing.composer_identity_digest = p_composer_identity_digest
      and v_existing.send_control_identity_digest = p_send_control_identity_digest
      and v_existing.provider_conversation_identity_digest = p_provider_conversation_identity_digest;
  end if;

  insert into public.backroom_android_native_targets(
    binding_id,device_id,room_id,screen_session_id,app_package_name,
    app_signer_sha256,composer_identity_digest,send_control_identity_digest,
    provider_conversation_identity_digest
  ) values (
    p_binding_id,p_device_id,p_room_id,p_screen_session_id,p_app_package_name,
    v_app.signing_certificate_sha256,p_composer_identity_digest,p_send_control_identity_digest,
    p_provider_conversation_identity_digest
  );

  return true;
end;
$function$;

revoke all on function public.register_backroom_android_native_target(
  uuid,uuid,uuid,uuid,text,text,text,text
) from public,anon,authenticated;
grant execute on function public.register_backroom_android_native_target(
  uuid,uuid,uuid,uuid,text,text,text,text
) to service_role;

-- Native UI execution remains unavailable until the trusted group-lease-to-device
-- queue forwarder and device ACK/result settlement are implemented. In particular,
-- a browser-created binding or device target record alone is not permission to wake.
create or replace function public.activate_backroom_wake_grant(
  p_host_id text,
  p_session_digest text,
  p_binding_id uuid,
  p_grant_id uuid,
  p_ttl_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $activate_wake$
declare
  v_binding public.backroom_input_bindings%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_host_id is null or p_session_digest is null or p_binding_id is null
    or p_grant_id is null or p_ttl_seconds is null
    or p_ttl_seconds < 60 or p_ttl_seconds > 86400 then
    raise exception 'Invalid Backroom wake grant activation';
  end if;

  select * into v_binding
  from public.backroom_input_bindings b
  where b.id = p_binding_id and b.host_id = p_host_id
    and b.session_digest = p_session_digest and b.revoked_at is null
  for update;

  if not found then return false; end if;

  -- This staged bridge deliberately refuses every native app surface. The
  -- Android device target can be registered and audited, but no wake lease is
  -- sent to the handset until the trusted forwarder/settlement PR is ready.
  if v_binding.surface in ('desktop_app','windows_app','android_app') then
    return false;
  end if;

  if v_binding.wake_enabled
    and v_binding.wake_grant_id = p_grant_id
    and v_binding.wake_expires_at > v_now then
    return true;
  end if;

  if v_binding.wake_enabled and v_binding.wake_grant_id is distinct from p_grant_id
    and v_binding.wake_expires_at > v_now then
    return false;
  end if;

  if not exists (
    select 1 from public.backroom_hosts h
    where h.host_id = p_host_id and h.owner_id = v_binding.owner_id
      and h.revoked_at is null and h.expires_at > v_now
  ) then return false; end if;

  if not exists (
    select 1 from public.participants p
    where p.id = v_binding.participant_id and p.room_id = v_binding.room_id
      and p.status in ('connected','active','autonomous')
  ) then return false; end if;

  if not exists (
    select 1 from public.agent_connections ac
    where ac.room_id = v_binding.room_id
      and ac.participant_id = v_binding.participant_id
      and ac.owner_id = v_binding.owner_id
      and ac.revoked_at is null and ac.expires_at > v_now
  ) then return false; end if;

  if not exists (
    select 1 from public.rub_minds_mcp_sessions ms
    where ms.session_digest = p_session_digest
      and ms.room_id = v_binding.room_id
      and ms.participant_id = v_binding.participant_id
      and ms.terminated_at is null and ms.expires_at > v_now
      and ms.agent_credential_ciphertext is not null
  ) then return false; end if;

  update public.backroom_input_bindings
  set wake_enabled = true, wake_grant_id = p_grant_id,
      wake_last_revoked_grant_id = null, confirmed_at = v_now,
      wake_expires_at = v_now + pg_catalog.make_interval(secs => p_ttl_seconds),
      updated_at = v_now
  where id = p_binding_id;

  return true;
end;
$activate_wake$;

revoke all on function public.activate_backroom_wake_grant(text,text,uuid,uuid,integer)
  from public,anon,authenticated;
grant execute on function public.activate_backroom_wake_grant(text,text,uuid,uuid,integer)
  to service_role;

comment on column public.backroom_android_native_targets.provider_conversation_identity_digest is
  'Opaque SHA-256 identity re-resolved by the paired Android companion; never stores raw provider conversation identifiers.';
comment on function public.register_backroom_android_native_target(uuid,uuid,uuid,uuid,text,text,text,text) is
  'Device-bearer-authenticated Edge Function calls this only after Android Accessibility revalidates the selected composer, Send control and current provider conversation.';
comment on function public.activate_backroom_wake_grant(text,text,uuid,uuid,integer) is
  'Managed browser wake grants are bounded to 24 hours. Native app surfaces remain denied until trusted device forwarding and result settlement are enabled.';
