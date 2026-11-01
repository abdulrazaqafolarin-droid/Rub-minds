-- Cloud-connected Backroom device registry and selected-app inventory.
-- Staging-first rollout: validate this migration and Edge Function before any production deployment.
create table if not exists public.backroom_devices (
  device_id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  token_digest text not null unique check (token_digest ~ '^[0-9a-f]{64}$'),
  device_label text not null check (char_length(btrim(device_label)) between 1 and 80),
  platform text not null check (platform in ('android','windows','macos','linux')),
  os_version text not null default '' check (char_length(os_version) <= 40),
  app_version text not null default '' check (char_length(app_version) <= 40),
  status text not null default 'pending' check (status in ('pending','active','revoked')),
  capabilities jsonb not null default '{"appDiscovery":true,"separateAppData":false,"embeddedVirtualApp":false,"liveScreen":false,"touchControl":false,"desktopControl":false,"terminalControl":false}'::jsonb,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  approved_at timestamptz,
  revoked_at timestamptz,
  last_seen_at timestamptz
);
alter table public.backroom_devices enable row level security;
revoke all on table public.backroom_devices from public, anon, authenticated;
grant select, update(last_seen_at) on table public.backroom_devices to service_role;

create table if not exists public.backroom_device_pairings (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  code_digest text not null unique check (code_digest ~ '^[0-9a-f]{64}$'),
  device_label text not null check (char_length(btrim(device_label)) between 1 and 80),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  device_id uuid references public.backroom_devices(device_id) on delete set null,
  created_at timestamptz not null default pg_catalog.clock_timestamp()
);
alter table public.backroom_device_pairings enable row level security;
revoke all on table public.backroom_device_pairings from public, anon, authenticated;
grant select, insert, delete on table public.backroom_device_pairings to service_role;
create index if not exists backroom_devices_owner_idx on public.backroom_devices(owner_id, created_at desc);
create index if not exists backroom_device_pairings_room_idx on public.backroom_device_pairings(room_id);
create index if not exists backroom_device_pairings_device_idx on public.backroom_device_pairings(device_id) where device_id is not null;

create table if not exists public.backroom_device_room_bindings (
  device_id uuid not null references public.backroom_devices(device_id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  revoked_at timestamptz,
  primary key(device_id, room_id)
);
alter table public.backroom_device_room_bindings enable row level security;
revoke all on table public.backroom_device_room_bindings from public, anon, authenticated;
grant select on table public.backroom_device_room_bindings to service_role;
create index if not exists backroom_device_room_bindings_room_fk_idx on public.backroom_device_room_bindings(room_id);
create index if not exists backroom_device_room_bindings_owner_idx on public.backroom_device_room_bindings(owner_id);
create index if not exists backroom_device_room_bindings_room_idx on public.backroom_device_room_bindings(room_id) where revoked_at is null;

create table if not exists public.backroom_device_apps (
  device_id uuid not null references public.backroom_devices(device_id) on delete cascade,
  package_name text not null check (package_name ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'),
  app_label text not null check (char_length(btrim(app_label)) between 1 and 120),
  signing_certificate_sha256 text not null check (signing_certificate_sha256 ~ '^[0-9a-f]{64}(\.[0-9a-f]{64})*$'),
  version_name text not null default '' check (char_length(version_name) <= 80),
  draft_insertion_allowed boolean not null default false,
  discovered_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key(device_id, package_name)
);
alter table public.backroom_device_apps enable row level security;
revoke all on table public.backroom_device_apps from public, anon, authenticated;
grant select on table public.backroom_device_apps to service_role;

create table if not exists public.backroom_device_events (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  device_id uuid not null references public.backroom_devices(device_id) on delete cascade,
  actor_type text not null check (actor_type in ('owner','device','ai','system')),
  actor_id text not null check (char_length(btrim(actor_id)) between 1 and 128),
  event_type text not null check (event_type in ('device_paired','device_approved','device_revoked','device_connected','device_disconnected','app_added','app_removed','app_open_requested')),
  package_name text,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  metadata jsonb not null default '{}'::jsonb,
  constraint backroom_device_event_package_check check (
    package_name is null or package_name ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'
  )
);
alter table public.backroom_device_events enable row level security;
revoke all on table public.backroom_device_events from public, anon, authenticated;
grant select, insert on table public.backroom_device_events to service_role;
create index if not exists backroom_device_events_room_idx on public.backroom_device_events(room_id, created_at desc);
create index if not exists backroom_device_events_device_idx on public.backroom_device_events(device_id, created_at desc);

-- A one-use, five-minute pairing code is claimed atomically. Only the service role
-- may call this function; device and owner credentials never call it directly.
create or replace function public.claim_backroom_device_pairing(
  p_code_digest text,
  p_device_id uuid,
  p_token_digest text,
  p_device_label text,
  p_os_version text,
  p_app_version text
) returns table(device_id uuid, owner_id uuid, room_id uuid)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_pairing public.backroom_device_pairings%rowtype;
  v_device_count integer;
begin
  if p_code_digest is null or p_code_digest !~ '^[0-9a-f]{64}$'
    or p_token_digest is null or p_token_digest !~ '^[0-9a-f]{64}$'
    or p_device_id is null or p_device_label is null
    or char_length(btrim(p_device_label)) not between 1 and 80
    or char_length(coalesce(p_os_version,'')) > 40
    or char_length(coalesce(p_app_version,'')) > 40 then
    raise exception 'Invalid device pairing input';
  end if;
  select * into v_pairing
    from public.backroom_device_pairings
    where code_digest = p_code_digest and claimed_at is null
      and expires_at > pg_catalog.clock_timestamp()
    for update;
  if not found then return; end if;
  if exists(select 1 from public.backroom_devices where token_digest = p_token_digest)
    or exists(select 1 from public.backroom_devices where device_id = p_device_id) then
    raise exception 'Device credential already exists';
  end if;
  if not exists(select 1 from public.rooms where id = v_pairing.room_id and owner_id = v_pairing.owner_id) then
    return;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_pairing.owner_id::text, 0));
  select count(*) into v_device_count from public.backroom_devices
    where owner_id=v_pairing.owner_id and status <> 'revoked';
  if v_device_count >= 5 then return; end if;
  insert into public.backroom_devices(
    device_id, owner_id, token_digest, device_label, platform, os_version, app_version, status
  ) values (
    p_device_id, v_pairing.owner_id, p_token_digest, btrim(p_device_label), 'android',
    coalesce(p_os_version,''), coalesce(p_app_version,''), 'pending'
  );
  insert into public.backroom_device_room_bindings(device_id, room_id, owner_id)
    values(p_device_id, v_pairing.room_id, v_pairing.owner_id);
  update public.backroom_device_pairings
    set claimed_at = pg_catalog.clock_timestamp(), device_id = p_device_id
    where id = v_pairing.id and claimed_at is null;
  insert into public.backroom_device_events(room_id, device_id, actor_type, actor_id, event_type)
    values(v_pairing.room_id, p_device_id, 'device', p_device_id::text, 'device_paired');
  return query select p_device_id, v_pairing.owner_id, v_pairing.room_id;
end;
$function$;
revoke all on function public.claim_backroom_device_pairing(text,uuid,text,text,text,text) from public, anon, authenticated;
grant execute on function public.claim_backroom_device_pairing(text,uuid,text,text,text,text) to service_role;

-- Replace only this device's selected-app list in one transaction.
create or replace function public.sync_backroom_device_apps(p_device_id uuid, p_apps jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_count integer;
begin
  if p_device_id is null or coalesce(jsonb_typeof(p_apps), '') <> 'array' then
    raise exception 'Invalid device app inventory';
  end if;
  if jsonb_array_length(p_apps) > 100 then
    raise exception 'Invalid device app inventory';
  end if;
  if not exists(select 1 from public.backroom_devices where device_id=p_device_id and status='active') then
    raise exception 'Device is not approved';
  end if;
  if exists(
    select 1 from jsonb_to_recordset(p_apps) as app(package_name text, app_label text, signing_certificate_sha256 text, version_name text, draft_insertion_allowed boolean)
    where app.package_name is null or app.package_name !~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$'
      or app.app_label is null or char_length(btrim(app.app_label)) not between 1 and 120
      or app.signing_certificate_sha256 is null or app.signing_certificate_sha256 !~ '^[0-9a-f]{64}(\.[0-9a-f]{64})*$'
      or char_length(coalesce(app.version_name,'')) > 80
      or app.draft_insertion_allowed is null
  ) then
    raise exception 'Invalid selected app record';
  end if;
  insert into public.backroom_device_events(room_id, device_id, actor_type, actor_id, event_type, package_name)
    select binding.room_id, p_device_id, 'device', p_device_id::text, 'app_removed', current_app.package_name
    from public.backroom_device_apps current_app
    join public.backroom_device_room_bindings binding on binding.device_id=p_device_id and binding.revoked_at is null
    where current_app.device_id=p_device_id
      and not exists (
        select 1 from jsonb_to_recordset(p_apps) as next_app(package_name text)
        where next_app.package_name=current_app.package_name
      );
  insert into public.backroom_device_events(room_id, device_id, actor_type, actor_id, event_type, package_name)
    select binding.room_id, p_device_id, 'device', p_device_id::text, 'app_added', next_app.package_name
    from jsonb_to_recordset(p_apps) as next_app(package_name text)
    cross join public.backroom_device_room_bindings binding
    where binding.device_id=p_device_id and binding.revoked_at is null
      and not exists (
        select 1 from public.backroom_device_apps current_app
        where current_app.device_id=p_device_id and current_app.package_name=next_app.package_name
      );
  delete from public.backroom_device_apps where device_id=p_device_id;
  insert into public.backroom_device_apps(device_id, package_name, app_label, signing_certificate_sha256, version_name, draft_insertion_allowed)
    select p_device_id, app.package_name, app.app_label, app.signing_certificate_sha256, coalesce(app.version_name,''), app.draft_insertion_allowed
    from jsonb_to_recordset(p_apps) as app(package_name text, app_label text, signing_certificate_sha256 text, version_name text, draft_insertion_allowed boolean);
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;
revoke all on function public.sync_backroom_device_apps(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.sync_backroom_device_apps(uuid,jsonb) to service_role;

-- Owner actions update device state and append their activity event in one transaction.
create or replace function public.approve_backroom_device(p_device_id uuid, p_room_id uuid, p_owner_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_device_id uuid;
begin
  if p_device_id is null or p_room_id is null or p_owner_id is null
    or not exists(select 1 from public.rooms where id=p_room_id and owner_id=p_owner_id)
    or not exists(select 1 from public.backroom_device_room_bindings
      where device_id=p_device_id and room_id=p_room_id and owner_id=p_owner_id and revoked_at is null) then
    return false;
  end if;
  update public.backroom_devices
    set status='active', approved_at=pg_catalog.clock_timestamp(), revoked_at=null
    where device_id=p_device_id and owner_id=p_owner_id and status='pending'
    returning device_id into v_device_id;
  if not found then return false; end if;
  insert into public.backroom_device_events(room_id,device_id,actor_type,actor_id,event_type)
    values(p_room_id,p_device_id,'owner',p_owner_id::text,'device_approved');
  return true;
end;
$function$;
revoke all on function public.approve_backroom_device(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.approve_backroom_device(uuid,uuid,uuid) to service_role;

create or replace function public.revoke_backroom_device(p_device_id uuid, p_room_id uuid, p_owner_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_device_id uuid;
begin
  if p_device_id is null or p_room_id is null or p_owner_id is null
    or not exists(select 1 from public.rooms where id=p_room_id and owner_id=p_owner_id)
    or not exists(select 1 from public.backroom_device_room_bindings
      where device_id=p_device_id and room_id=p_room_id and owner_id=p_owner_id and revoked_at is null) then
    return false;
  end if;
  update public.backroom_devices
    set status='revoked', revoked_at=pg_catalog.clock_timestamp()
    where device_id=p_device_id and owner_id=p_owner_id and status <> 'revoked'
    returning device_id into v_device_id;
  if not found then return false; end if;
  update public.backroom_device_room_bindings
    set revoked_at=pg_catalog.clock_timestamp()
    where device_id=p_device_id and room_id=p_room_id and owner_id=p_owner_id and revoked_at is null;
  insert into public.backroom_device_events(room_id,device_id,actor_type,actor_id,event_type)
    values(p_room_id,p_device_id,'owner',p_owner_id::text,'device_revoked');
  -- Drop the live app catalog on revoke; append-only action history remains.
  delete from public.backroom_device_apps where device_id=p_device_id;
  return true;
end;
$function$;
revoke all on function public.revoke_backroom_device(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.revoke_backroom_device(uuid,uuid,uuid) to service_role;
