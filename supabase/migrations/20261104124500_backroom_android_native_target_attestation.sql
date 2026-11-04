-- Short-lived attestation for the exact Android composer/Send/provider conversation.
-- Only opaque SHA-256 identities are persisted; no labels, accessibility text,
-- raw conversation IDs, prompts or chat history are stored.
create table if not exists public.backroom_android_native_targets (
  native_target_id uuid primary key default pg_catalog.gen_random_uuid(),
  device_id uuid not null references public.backroom_devices(device_id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  screen_session_id uuid not null references public.backroom_desktop_sessions(session_id) on delete cascade,
  request_id uuid not null,
  issued_at timestamptz not null,
  app_package_name text not null
    check (app_package_name ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'),
  app_signer_sha256 text not null check (app_signer_sha256 ~ '^[a-f0-9]{64}$'),
  composer_identity_digest text not null check (composer_identity_digest ~ '^[a-f0-9]{64}$'),
  send_control_identity_digest text not null check (send_control_identity_digest ~ '^[a-f0-9]{64}$'),
  provider_conversation_identity_digest text not null check (provider_conversation_identity_digest ~ '^[a-f0-9]{64}$'),
  target_revision integer not null default 1 check (target_revision = 1),
  status text not null default 'active' check (status in ('active','revoked','expired')),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  unique(device_id,request_id),
  check (expires_at > created_at),
  check (expires_at <= created_at + interval '2 minutes'),
  check ((status = 'revoked' and revoked_at is not null) or status <> 'revoked')
);
alter table public.backroom_android_native_targets enable row level security;
revoke all on table public.backroom_android_native_targets from public,anon,authenticated;
grant select,insert,update on table public.backroom_android_native_targets to service_role;

create unique index if not exists backroom_android_native_targets_one_active_per_screen_idx
  on public.backroom_android_native_targets(device_id,screen_session_id)
  where status='active';
create index if not exists backroom_android_native_targets_expiry_idx
  on public.backroom_android_native_targets(expires_at)
  where status='active';
create index if not exists backroom_android_native_targets_room_idx
  on public.backroom_android_native_targets(room_id,created_at desc);

create or replace function public.register_backroom_android_native_target(
  p_device_id uuid,p_room_id uuid,p_screen_session_id uuid,p_request_id uuid,
  p_issued_at timestamptz,p_app_package_name text,p_app_signer_sha256 text,
  p_composer_identity_digest text,p_send_control_identity_digest text,
  p_provider_conversation_identity_digest text
)
returns table(out_native_target_id uuid,out_expires_at timestamptz,out_reused boolean)
language plpgsql security definer set search_path=''
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_device public.backroom_devices%rowtype;
  v_session public.backroom_desktop_sessions%rowtype;
  v_existing public.backroom_android_native_targets%rowtype;
  v_signers text;
  v_expires_at timestamptz;
begin
  if p_device_id is null or p_room_id is null or p_screen_session_id is null or p_request_id is null
    or p_issued_at is null or p_issued_at < v_now - interval '30 seconds'
    or p_issued_at > v_now + interval '3 seconds'
    or p_app_package_name is null
    or p_app_package_name !~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'
    or pg_catalog.char_length(p_app_package_name) > 255
    or p_app_signer_sha256 is null or p_app_signer_sha256 !~ '^[a-f0-9]{64}$'
    or p_composer_identity_digest is null or p_composer_identity_digest !~ '^[a-f0-9]{64}$'
    or p_send_control_identity_digest is null or p_send_control_identity_digest !~ '^[a-f0-9]{64}$'
    or p_provider_conversation_identity_digest is null or p_provider_conversation_identity_digest !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid Android native target attestation';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_device_id::text || ':' || p_screen_session_id::text,0)
  );

  select * into v_device from public.backroom_devices d
  where d.device_id=p_device_id and d.status='active' and d.platform='android' for update;
  if not found then raise exception 'Android device is not active'; end if;

  if not exists (
    select 1 from public.backroom_device_room_bindings b
    where b.device_id=p_device_id and b.room_id=p_room_id
      and b.owner_id=v_device.owner_id and b.revoked_at is null
  ) then raise exception 'Android device is not paired to this room'; end if;

  select * into v_session from public.backroom_desktop_sessions s
  where s.session_id=p_screen_session_id and s.device_id=p_device_id
    and s.room_id=p_room_id and s.session_type='screen'
    and s.status='active' and s.expires_at > v_now for update;
  if not found then raise exception 'Android screen session is not active'; end if;

  select a.signing_certificate_sha256 into v_signers
  from public.backroom_device_apps a
  where a.device_id=p_device_id and a.package_name=p_app_package_name;
  if not found or not (p_app_signer_sha256 = any(pg_catalog.string_to_array(v_signers,'.'))) then
    raise exception 'Android app signer does not match selected app inventory';
  end if;

  select * into v_existing from public.backroom_android_native_targets t
  where t.device_id=p_device_id and t.request_id=p_request_id for update;
  if found then
    if v_existing.room_id=p_room_id
      and v_existing.screen_session_id=p_screen_session_id
      and v_existing.issued_at=p_issued_at
      and v_existing.app_package_name=p_app_package_name
      and v_existing.app_signer_sha256=p_app_signer_sha256
      and v_existing.composer_identity_digest=p_composer_identity_digest
      and v_existing.send_control_identity_digest=p_send_control_identity_digest
      and v_existing.provider_conversation_identity_digest=p_provider_conversation_identity_digest
      and v_existing.status='active' and v_existing.expires_at > v_now then
      return query select v_existing.native_target_id,v_existing.expires_at,true;
      return;
    end if;
    raise exception 'Android native target request ID was already used';
  end if;

  if exists (
    select 1 from public.backroom_android_native_targets t
    where t.device_id=p_device_id and t.screen_session_id=p_screen_session_id
      and t.status='active' and t.issued_at > p_issued_at and t.expires_at > v_now
  ) then raise exception 'A newer Android target selection already exists'; end if;

  update public.backroom_android_native_targets t
  set status='revoked',revoked_at=v_now
  where t.device_id=p_device_id and t.screen_session_id=p_screen_session_id and t.status='active';

  v_expires_at := least(v_session.expires_at,v_now + interval '2 minutes');
  if v_expires_at <= v_now then raise exception 'Android screen session expires too soon'; end if;

  insert into public.backroom_android_native_targets(
    device_id,room_id,screen_session_id,request_id,issued_at,app_package_name,
    app_signer_sha256,composer_identity_digest,send_control_identity_digest,
    provider_conversation_identity_digest,target_revision,status,expires_at
  ) values (
    p_device_id,p_room_id,p_screen_session_id,p_request_id,p_issued_at,p_app_package_name,
    p_app_signer_sha256,p_composer_identity_digest,p_send_control_identity_digest,
    p_provider_conversation_identity_digest,1,'active',v_expires_at
  ) returning native_target_id,expires_at into out_native_target_id,out_expires_at;
  out_reused := false;
  return next;
end;
$function$;

revoke all on function public.register_backroom_android_native_target(uuid,uuid,uuid,uuid,timestamptz,text,text,text,text,text)
  from public,anon,authenticated;
grant execute on function public.register_backroom_android_native_target(uuid,uuid,uuid,uuid,timestamptz,text,text,text,text,text) to service_role;

create or replace function public.revoke_backroom_android_native_target(
  p_device_id uuid,p_room_id uuid,p_screen_session_id uuid,p_native_target_id uuid
)
returns boolean language plpgsql security definer set search_path=''
as $function$
declare v_count integer;
begin
  update public.backroom_android_native_targets t
  set status='revoked',revoked_at=pg_catalog.clock_timestamp()
  where t.native_target_id=p_native_target_id and t.device_id=p_device_id
    and t.room_id=p_room_id and t.screen_session_id=p_screen_session_id and t.status='active';
  get diagnostics v_count = row_count;
  return v_count=1;
end;
$function$;

revoke all on function public.revoke_backroom_android_native_target(uuid,uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.revoke_backroom_android_native_target(uuid,uuid,uuid,uuid) to service_role;

comment on table public.backroom_android_native_targets is
  'Short-lived Android device attestation for exact selected composer, Send control and provider conversation. It is not a group AI binding or autonomous-send grant.';
comment on column public.backroom_android_native_targets.provider_conversation_identity_digest is
  'Opaque locally generated provider-conversation SHA-256 digest; raw provider identifiers and history never leave the handset.';
