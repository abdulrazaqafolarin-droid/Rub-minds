-- Windows/macOS/Linux desktop application inventory. Unlike Android packages,
-- this catalog stores only an owner-selected app label and executable hash.
-- Local executable paths and private app data never leave the computer.
create table if not exists public.backroom_desktop_apps (
  device_id uuid not null references public.backroom_devices(device_id) on delete cascade,
  app_id uuid not null,
  app_label text not null check (char_length(btrim(app_label)) between 1 and 120),
  executable_sha256 text not null check (executable_sha256 ~ '^[0-9a-f]{64}$'),
  discovered_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key(device_id, app_id)
);
alter table public.backroom_desktop_apps enable row level security;
revoke all on table public.backroom_desktop_apps from public, anon, authenticated;
grant select, insert, delete on table public.backroom_desktop_apps to service_role;
create index if not exists backroom_desktop_apps_device_idx on public.backroom_desktop_apps(device_id, app_label);

create or replace function public.sync_backroom_desktop_apps(p_device_id uuid, p_apps jsonb)
returns integer language plpgsql security definer set search_path=''
as $function$
declare v_count integer;
begin
  if p_device_id is null or coalesce(jsonb_typeof(p_apps),'') <> 'array'
    or jsonb_array_length(p_apps) > 100 then
    raise exception 'Invalid desktop app inventory';
  end if;
  if not exists(select 1 from public.backroom_devices where device_id=p_device_id and status='active') then
    raise exception 'Desktop device is not active';
  end if;
  if exists(
    select 1 from jsonb_to_recordset(p_apps) as app(app_id uuid,app_label text,executable_sha256 text)
    where app.app_id is null or app.app_label is null
      or char_length(btrim(app.app_label)) not between 1 and 120
      or app.executable_sha256 is null or app.executable_sha256 !~ '^[0-9a-f]{64}$'
  ) then raise exception 'Invalid desktop app record'; end if;

  insert into public.backroom_device_events(room_id,device_id,actor_type,actor_id,event_type,metadata)
    select b.room_id,p_device_id,'device',p_device_id::text,'app_removed',
      jsonb_build_object('appId',old.app_id)
    from public.backroom_desktop_apps old
    join public.backroom_device_room_bindings b on b.device_id=p_device_id and b.revoked_at is null
    where old.device_id=p_device_id and not exists(
      select 1 from jsonb_to_recordset(p_apps) as next_app(app_id uuid) where next_app.app_id=old.app_id
    );
  insert into public.backroom_device_events(room_id,device_id,actor_type,actor_id,event_type,metadata)
    select b.room_id,p_device_id,'device',p_device_id::text,'app_added',
      jsonb_build_object('appId',app.app_id,'label',app.app_label)
    from jsonb_to_recordset(p_apps) as app(app_id uuid,app_label text,executable_sha256 text)
    cross join public.backroom_device_room_bindings b
    where b.device_id=p_device_id and b.revoked_at is null
      and not exists(select 1 from public.backroom_desktop_apps old where old.device_id=p_device_id and old.app_id=app.app_id);

  delete from public.backroom_desktop_apps where device_id=p_device_id;
  insert into public.backroom_desktop_apps(device_id,app_id,app_label,executable_sha256)
    select p_device_id,app.app_id,app.app_label,app.executable_sha256
    from jsonb_to_recordset(p_apps) as app(app_id uuid,app_label text,executable_sha256 text);
  get diagnostics v_count=row_count;
  return v_count;
end;
$function$;
revoke all on function public.sync_backroom_desktop_apps(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.sync_backroom_desktop_apps(uuid,jsonb) to service_role;

create or replace function public.revoke_backroom_device(p_device_id uuid,p_room_id uuid,p_owner_id uuid)
returns boolean language plpgsql security definer set search_path=''
as $function$
declare v_device_id uuid;
begin
  if p_device_id is null or p_room_id is null or p_owner_id is null
    or not exists(select 1 from public.rooms where id=p_room_id and owner_id=p_owner_id)
    or not exists(select 1 from public.backroom_device_room_bindings
      where device_id=p_device_id and room_id=p_room_id and owner_id=p_owner_id and revoked_at is null) then
    return false;
  end if;
  update public.backroom_devices set status='revoked',revoked_at=pg_catalog.clock_timestamp()
    where device_id=p_device_id and owner_id=p_owner_id and status<>'revoked'
    returning device_id into v_device_id;
  if not found then return false; end if;
  update public.backroom_device_room_bindings set revoked_at=pg_catalog.clock_timestamp()
    where device_id=p_device_id and room_id=p_room_id and owner_id=p_owner_id and revoked_at is null;
  insert into public.backroom_device_events(room_id,device_id,actor_type,actor_id,event_type)
    values(p_room_id,p_device_id,'owner',p_owner_id::text,'device_revoked');
  delete from public.backroom_device_apps where device_id=p_device_id;
  delete from public.backroom_desktop_apps where device_id=p_device_id;
  return true;
end;
$function$;
revoke all on function public.revoke_backroom_device(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.revoke_backroom_device(uuid,uuid,uuid) to service_role;
