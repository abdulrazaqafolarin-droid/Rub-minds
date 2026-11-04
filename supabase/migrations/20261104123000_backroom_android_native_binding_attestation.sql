-- A phone-originated attestation binds one live Android screen session,
-- selected app signer, composer, Send control and provider conversation to an
-- owner-selected AI MCP session. It never enables wake by itself.
create table if not exists public.backroom_native_binding_intents (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  host_id text not null references public.backroom_hosts(host_id) on delete cascade,
  session_digest text not null references public.rub_minds_mcp_sessions(session_digest) on delete cascade,
  device_id uuid not null references public.backroom_devices(device_id) on delete cascade,
  screen_session_id uuid not null references public.backroom_desktop_sessions(session_id) on delete cascade,
  app_package_name text not null check (app_package_name ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'),
  signing_certificate_sha256 text not null check (signing_certificate_sha256 ~ '^[0-9a-f]{64}(\.[0-9a-f]{64})*$'),
  participation_mode text not null check (participation_mode in ('mentions','smart')),
  max_wakes_per_minute integer not null default 6 check (max_wakes_per_minute between 1 and 6),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  check (expires_at > created_at)
);
alter table public.backroom_native_binding_intents enable row level security;
revoke all on table public.backroom_native_binding_intents from public, anon, authenticated;
grant select, insert, update, delete on table public.backroom_native_binding_intents to service_role;
create index if not exists backroom_native_binding_intents_expiry_idx
  on public.backroom_native_binding_intents(expires_at)
  where consumed_at is null;

create table if not exists public.backroom_native_input_targets (
  binding_id uuid primary key references public.backroom_input_bindings(id) on delete cascade,
  device_id uuid not null references public.backroom_devices(device_id) on delete cascade,
  screen_session_id uuid not null references public.backroom_desktop_sessions(session_id) on delete cascade,
  app_package_name text not null check (app_package_name ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'),
  signing_certificate_sha256 text not null check (signing_certificate_sha256 ~ '^[0-9a-f]{64}(\.[0-9a-f]{64})*$'),
  composer_target_id text not null check (composer_target_id ~ '^[a-f0-9]{64}$'),
  send_control_target_id text not null check (send_control_target_id ~ '^[a-f0-9]{64}$'),
  provider_conversation_identity_digest text not null check (provider_conversation_identity_digest ~ '^[a-f0-9]{64}$'),
  attested_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique(device_id, screen_session_id)
);
alter table public.backroom_native_input_targets enable row level security;
revoke all on table public.backroom_native_input_targets from public, anon, authenticated;
grant select, insert, delete on table public.backroom_native_input_targets to service_role;
create index if not exists backroom_native_input_targets_device_idx
  on public.backroom_native_input_targets(device_id, screen_session_id);

create or replace function public.register_backroom_native_input_binding_from_device(
  p_intent_id uuid,
  p_device_id uuid,
  p_screen_session_id uuid,
  p_app_package_name text,
  p_signing_certificate_sha256 text,
  p_composer_target_id text,
  p_send_control_target_id text,
  p_provider_conversation_identity_digest text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_intent public.backroom_native_binding_intents%rowtype;
  v_binding_id uuid;
  v_target_id text;
  v_space_id text;
  v_target_fingerprint text;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_intent_id is null or p_device_id is null or p_screen_session_id is null
    or p_app_package_name is null
    or p_app_package_name !~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'
    or p_signing_certificate_sha256 is null
    or p_signing_certificate_sha256 !~ '^[0-9a-f]{64}(\.[0-9a-f]{64})*$'
    or p_composer_target_id is null or p_composer_target_id !~ '^[a-f0-9]{64}$'
    or p_send_control_target_id is null or p_send_control_target_id !~ '^[a-f0-9]{64}$'
    or p_provider_conversation_identity_digest is null
    or p_provider_conversation_identity_digest !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid Android native binding attestation';
  end if;

  select * into v_intent
  from public.backroom_native_binding_intents i
  where i.id = p_intent_id
    and i.device_id = p_device_id
    and i.screen_session_id = p_screen_session_id
    and i.app_package_name = p_app_package_name
    and i.signing_certificate_sha256 = p_signing_certificate_sha256
    and i.consumed_at is null
    and i.expires_at > v_now
  for update;

  if not found then
    raise exception 'Native binding intent is unavailable, expired, consumed or out of scope';
  end if;

  if not exists (
    select 1 from public.backroom_devices d
    where d.device_id = p_device_id and d.owner_id = v_intent.owner_id
      and d.platform = 'android' and d.status = 'active' and d.revoked_at is null
  ) then
    raise exception 'Android device is not active for the intent owner';
  end if;

  if not exists (
    select 1 from public.backroom_device_room_bindings b
    where b.device_id = p_device_id and b.room_id = v_intent.room_id
      and b.owner_id = v_intent.owner_id and b.revoked_at is null
  ) then
    raise exception 'Android device is not bound to the requested room';
  end if;

  if not exists (
    select 1 from public.backroom_desktop_sessions s
    where s.session_id = p_screen_session_id and s.device_id = p_device_id
      and s.room_id = v_intent.room_id and s.session_type = 'screen'
      and s.status = 'active' and s.expires_at > v_now
  ) then
    raise exception 'Android screen session is not active';
  end if;

  if not exists (
    select 1 from public.backroom_device_apps a
    where a.device_id = p_device_id and a.package_name = p_app_package_name
      and a.signing_certificate_sha256 = p_signing_certificate_sha256
  ) then
    raise exception 'Selected Android app signer does not match device inventory';
  end if;

  if not exists (
    select 1 from public.backroom_hosts h
    where h.host_id = v_intent.host_id and h.owner_id = v_intent.owner_id
      and h.revoked_at is null and h.expires_at > v_now
  ) then
    raise exception 'Backroom host registration is unavailable';
  end if;

  if not exists (
    select 1 from public.rooms r where r.id = v_intent.room_id and r.owner_id = v_intent.owner_id
  ) or not exists (
    select 1 from public.participants p
    where p.id = v_intent.participant_id and p.room_id = v_intent.room_id
      and p.kind in ('original_session','model','external_agent')
      and p.status in ('connected','active','autonomous')
  ) or not exists (
    select 1 from public.agent_connections c
    where c.room_id = v_intent.room_id and c.participant_id = v_intent.participant_id
      and c.owner_id = v_intent.owner_id and c.revoked_at is null and c.expires_at > v_now
  ) or not exists (
    select 1 from public.rub_minds_mcp_sessions m
    where m.session_digest = v_intent.session_digest and m.room_id = v_intent.room_id
      and m.participant_id = v_intent.participant_id and m.terminated_at is null
      and m.agent_credential_ciphertext is not null and m.expires_at > v_now
  ) then
    raise exception 'Original AI participant or MCP session is no longer authorized';
  end if;

  v_target_id := 'android_' || pg_catalog.replace(p_screen_session_id::text, '-', '');
  v_space_id := 'android_' || pg_catalog.replace(p_device_id::text, '-', '');
  v_target_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.concat_ws('|', p_device_id::text, p_screen_session_id::text,
        p_app_package_name, p_signing_certificate_sha256, p_composer_target_id,
        p_send_control_target_id, p_provider_conversation_identity_digest),
      'UTF8'
    )),
    'hex'
  );

  insert into public.backroom_input_bindings(
    owner_id,room_id,participant_id,host_id,session_digest,
    space_id,session_id,target_id,target_identity_fingerprint,target_revision,
    surface,locator_kind,locator_value,participation_mode,max_wakes_per_minute,
    provider_conversation_identity_digest,wake_enabled,confirmed_at,wake_expires_at
  ) values (
    v_intent.owner_id,v_intent.room_id,v_intent.participant_id,v_intent.host_id,v_intent.session_digest,
    v_space_id,p_screen_session_id::text,v_target_id,v_target_fingerprint,1,
    'android_app','accessibility','android_accessibility_composer',v_intent.participation_mode,
    v_intent.max_wakes_per_minute,p_provider_conversation_identity_digest,false,null,null
  ) returning id into v_binding_id;

  insert into public.backroom_native_input_targets(
    binding_id,device_id,screen_session_id,app_package_name,signing_certificate_sha256,
    composer_target_id,send_control_target_id,provider_conversation_identity_digest
  ) values (
    v_binding_id,p_device_id,p_screen_session_id,p_app_package_name,p_signing_certificate_sha256,
    p_composer_target_id,p_send_control_target_id,p_provider_conversation_identity_digest
  );

  update public.backroom_native_binding_intents
  set consumed_at = v_now
  where id = v_intent.id and consumed_at is null;

  return v_binding_id;
end;
$function$;

revoke all on function public.register_backroom_native_input_binding_from_device(
  uuid,uuid,uuid,text,text,text,text,text
) from public, anon, authenticated;
grant execute on function public.register_backroom_native_input_binding_from_device(
  uuid,uuid,uuid,text,text,text,text,text
) to service_role;

comment on table public.backroom_native_binding_intents is
  'Short-lived owner-approved challenge that pins one AI MCP session, paired Android device and active screen session for device-originated binding attestation.';
comment on table public.backroom_native_input_targets is
  'Private device-attested composer, Send-control and provider-conversation digests; raw provider identifiers and UI text are never stored.';
