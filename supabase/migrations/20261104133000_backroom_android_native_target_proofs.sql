-- Short-lived, device-authenticated proof that one exact Android composer,
-- Send control and provider conversation were selected locally.
-- The proof contains only opaque digests; no provider IDs, titles or text.
create table if not exists public.backroom_android_native_target_proofs (
  proof_id uuid primary key default pg_catalog.gen_random_uuid(),
  device_id uuid not null references public.backroom_devices(device_id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  screen_session_id uuid not null,
  request_id uuid not null,
  app_package_name text not null check (app_package_name ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'),
  app_signer_sha256 text not null check (app_signer_sha256 ~ '^[a-f0-9]{64}$'),
  target_id text not null check (target_id ~ '^[a-f0-9]{64}$'),
  target_revision integer not null check (target_revision between 1 and 2147483647),
  composer_identity_digest text not null check (composer_identity_digest ~ '^[a-f0-9]{64}$'),
  send_control_identity_digest text not null check (send_control_identity_digest ~ '^[a-f0-9]{64}$'),
  provider_conversation_identity_digest text not null check (provider_conversation_identity_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_by_owner_id uuid,
  consumed_binding_id uuid,
  unique (device_id, request_id),
  check (target_id = composer_identity_digest),
  check (expires_at > created_at),
  check (
    (consumed_at is null and consumed_by_owner_id is null and consumed_binding_id is null)
    or (consumed_at is not null and consumed_by_owner_id is not null and consumed_binding_id is not null)
  )
);

alter table public.backroom_android_native_target_proofs enable row level security;
revoke all on table public.backroom_android_native_target_proofs from public, anon, authenticated;
grant select, insert, update on table public.backroom_android_native_target_proofs to service_role;
create index if not exists backroom_android_native_target_proof_expiry_idx
  on public.backroom_android_native_target_proofs(device_id, room_id, expires_at)
  where consumed_at is null;

alter table public.backroom_input_bindings
  add column if not exists native_target_proof_id uuid,
  add column if not exists native_device_id uuid,
  add column if not exists native_screen_session_id uuid,
  add column if not exists native_app_package_name text,
  add column if not exists native_app_signer_sha256 text,
  add column if not exists native_composer_identity_digest text,
  add column if not exists native_send_control_identity_digest text;

do $constraints$
begin
  if not exists(select 1 from pg_catalog.pg_constraint
      where conrelid='public.backroom_input_bindings'::regclass
        and conname='backroom_native_binding_target_proof_fields_check') then
    alter table public.backroom_input_bindings
      add constraint backroom_native_binding_target_proof_fields_check check (
        (
          native_target_proof_id is null
          and native_device_id is null
          and native_screen_session_id is null
          and native_app_package_name is null
          and native_app_signer_sha256 is null
          and native_composer_identity_digest is null
          and native_send_control_identity_digest is null
        )
        or
        (
          surface = 'android_app'
          and native_target_proof_id is not null
          and native_device_id is not null
          and native_screen_session_id is not null
          and native_app_package_name is not null
          and native_app_signer_sha256 ~ '^[a-f0-9]{64}$'
          and native_composer_identity_digest ~ '^[a-f0-9]{64}$'
          and native_send_control_identity_digest ~ '^[a-f0-9]{64}$'
          and provider_conversation_identity_digest ~ '^[a-f0-9]{64}$'
        )
      );
  end if;
  if not exists(select 1 from pg_catalog.pg_constraint
      where conrelid='public.backroom_input_bindings'::regclass
        and conname='backroom_android_native_wake_requires_target_proof_check') then
    alter table public.backroom_input_bindings
      add constraint backroom_android_native_wake_requires_target_proof_check check (
        surface <> 'android_app' or wake_enabled = false or native_target_proof_id is not null
      );
  end if;
end;
$constraints$;

-- Existing Android wake grants did not prove the exact device/screen binding.
update public.backroom_input_bindings
set wake_last_revoked_grant_id = wake_grant_id,
    wake_enabled = false,
    wake_grant_id = null,
    confirmed_at = null,
    wake_expires_at = null,
    updated_at = pg_catalog.clock_timestamp()
where surface = 'android_app' and wake_enabled = true and native_target_proof_id is null;

update public.backroom_wake_jobs j
set state = 'cancelled',
    lease_owner = null,
    lease_token_hash = null,
    lease_expires_at = null,
    last_error_code = 'authorization_denied',
    updated_at = pg_catalog.clock_timestamp()
from public.backroom_input_bindings b
where b.id = j.binding_id and b.surface = 'android_app'
  and b.native_target_proof_id is null and j.state in ('pending','leased');

-- A device proof is immutable. A different chat or target requires a fresh
-- proof and a new binding; an existing binding must never be silently retargeted.
create or replace function public.guard_backroom_android_native_target_proof()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.native_target_proof_id is distinct from old.native_target_proof_id
    or new.native_device_id is distinct from old.native_device_id
    or new.native_screen_session_id is distinct from old.native_screen_session_id
    or new.native_app_package_name is distinct from old.native_app_package_name
    or new.native_app_signer_sha256 is distinct from old.native_app_signer_sha256
    or new.native_composer_identity_digest is distinct from old.native_composer_identity_digest
    or new.native_send_control_identity_digest is distinct from old.native_send_control_identity_digest then
    raise check_violation using
      message = 'Android native target identity is immutable; revoke and create a fresh binding';
  end if;
  return new;
end;
$function$;

revoke all on function public.guard_backroom_android_native_target_proof() from public, anon, authenticated;
grant execute on function public.guard_backroom_android_native_target_proof() to service_role;
drop trigger if exists backroom_android_native_target_proof_immutable_trigger on public.backroom_input_bindings;
create trigger backroom_android_native_target_proof_immutable_trigger
before update of native_target_proof_id, native_device_id, native_screen_session_id,
  native_app_package_name, native_app_signer_sha256,
  native_composer_identity_digest, native_send_control_identity_digest
on public.backroom_input_bindings
for each row execute function public.guard_backroom_android_native_target_proof();

comment on table public.backroom_android_native_target_proofs is
  'Short-lived one-use proof created by the paired Android device after local composer, Send and provider-conversation revalidation. Stores only opaque identity digests.';

create or replace function public.register_backroom_android_native_binding(
  p_proof_id uuid,
  p_owner_id uuid,
  p_room_id uuid,
  p_participant_id uuid,
  p_host_id text,
  p_session_digest text,
  p_space_id text,
  p_participation_mode text default 'mentions',
  p_max_wakes_per_minute integer default 6
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_proof public.backroom_android_native_target_proofs%rowtype;
  v_binding_id uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_proof_id is null or p_owner_id is null or p_room_id is null or p_participant_id is null
    or p_host_id is null or char_length(btrim(p_host_id)) not between 1 and 128
    or p_session_digest is null or p_session_digest !~ '^[0-9a-f]{64}$'
    or p_space_id is null or char_length(btrim(p_space_id)) not between 1 and 128
    or p_participation_mode is null or p_participation_mode not in ('mentions','smart','task')
    or p_max_wakes_per_minute is null or p_max_wakes_per_minute not between 1 and 6 then
    raise exception 'Invalid Android native binding request';
  end if;

  select * into v_proof
  from public.backroom_android_native_target_proofs p
  where p.proof_id = p_proof_id
  for update;

  if not found or v_proof.consumed_at is not null or v_proof.expires_at <= v_now then
    raise exception 'Android native target proof is missing, expired or already consumed';
  end if;

  if v_proof.room_id is distinct from p_room_id then
    raise exception 'Android target proof belongs to a different room';
  end if;
  if not exists (select 1 from public.rooms r where r.id = v_proof.room_id and r.owner_id = p_owner_id) then
    raise exception 'Android target proof belongs to a different room owner';
  end if;
  if not exists (
    select 1 from public.backroom_hosts h
    where h.host_id = p_host_id and h.owner_id = p_owner_id
      and h.revoked_at is null and h.expires_at > v_now
  ) then
    raise exception 'Backroom host is missing, expired, revoked or owned by another user';
  end if;
  if not exists (
    select 1 from public.backroom_device_room_bindings rb
    join public.backroom_devices d on d.device_id = rb.device_id
    where rb.device_id = v_proof.device_id and rb.room_id = v_proof.room_id
      and rb.owner_id = p_owner_id and rb.revoked_at is null
      and d.owner_id = p_owner_id and d.platform = 'android' and d.status = 'active'
  ) then
    raise exception 'Android device is not actively paired to this owner and room';
  end if;
  if not exists (
    select 1 from public.backroom_desktop_sessions s
    where s.session_id = v_proof.screen_session_id
      and s.device_id = v_proof.device_id and s.room_id = v_proof.room_id
      and s.session_type = 'screen' and s.status = 'active' and s.expires_at > v_now
  ) then
    raise exception 'Android screen session is no longer active';
  end if;
  if not exists (
    select 1 from public.backroom_device_apps a
    where a.device_id = v_proof.device_id and a.package_name = v_proof.app_package_name
      and v_proof.app_signer_sha256 = any(pg_catalog.string_to_array(a.signing_certificate_sha256, '.'))
  ) then
    raise exception 'Android app signer is not in the approved device inventory';
  end if;
  if not exists (
    select 1
    from public.rub_minds_mcp_sessions s
    join public.participants p on p.id = s.participant_id and p.room_id = s.room_id
    join public.rooms r on r.id = s.room_id
    join public.agent_connections a on a.participant_id = p.id and a.room_id = r.id
      and a.owner_id = r.owner_id and a.revoked_at is null and a.expires_at > v_now
    where s.session_digest = p_session_digest
      and s.room_id = v_proof.room_id and s.participant_id = p_participant_id
      and s.agent_credential_ciphertext is not null
      and s.terminated_at is null and s.expires_at > v_now
      and p.kind in ('original_session','model','external_agent')
      and p.status in ('connected','active','autonomous') and r.owner_id = p_owner_id
  ) then
    raise exception 'Active MCP session does not authorize this group participant';
  end if;

  insert into public.backroom_input_bindings (
    owner_id, room_id, participant_id, host_id, session_digest,
    space_id, session_id, target_id, target_identity_fingerprint, target_revision,
    provider_conversation_identity_digest, surface, locator_kind, locator_value,
    participation_mode, max_wakes_per_minute,
    native_target_proof_id, native_device_id, native_screen_session_id,
    native_app_package_name, native_app_signer_sha256,
    native_composer_identity_digest, native_send_control_identity_digest,
    wake_enabled, confirmed_at, wake_expires_at
  ) values (
    p_owner_id, v_proof.room_id, p_participant_id, p_host_id, p_session_digest,
    p_space_id, v_proof.screen_session_id::text, v_proof.target_id,
    v_proof.app_signer_sha256, v_proof.target_revision,
    v_proof.provider_conversation_identity_digest, 'android_app', 'accessibility', v_proof.target_id,
    p_participation_mode, p_max_wakes_per_minute,
    v_proof.proof_id, v_proof.device_id, v_proof.screen_session_id,
    v_proof.app_package_name, v_proof.app_signer_sha256,
    v_proof.composer_identity_digest, v_proof.send_control_identity_digest,
    false, null, null
  ) returning id into v_binding_id;

  update public.backroom_android_native_target_proofs
  set consumed_at = v_now, consumed_by_owner_id = p_owner_id, consumed_binding_id = v_binding_id
  where proof_id = v_proof.proof_id and consumed_at is null;
  if not found then raise exception 'Android native target proof was consumed concurrently'; end if;

  return v_binding_id;
end;
$function$;

revoke all on function public.register_backroom_android_native_binding(uuid,uuid,uuid,uuid,text,text,text,text,integer)
  from public, anon, authenticated;
grant execute on function public.register_backroom_android_native_binding(uuid,uuid,uuid,uuid,text,text,text,text,integer)
  to service_role;

comment on function public.register_backroom_android_native_binding(uuid,uuid,uuid,uuid,text,text,text,text,integer) is
  'Consumes a short-lived device-authenticated Android target proof for the exact requested room and creates an inactive native input binding atomically.';
