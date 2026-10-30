-- Account-authenticated desktop companion registration.
-- Unlike Android's QR/code pairing, this path requires a verified Supabase
-- owner session inside the native companion and an explicit local confirm.
alter table public.backroom_devices
  add column if not exists device_public_key text
  check (device_public_key is null or device_public_key ~ '^[0-9a-f]{64}$');

create or replace function public.register_backroom_desktop_device(
  p_device_id uuid,
  p_owner_id uuid,
  p_room_id uuid,
  p_token_digest text,
  p_device_public_key text,
  p_device_label text,
  p_platform text,
  p_os_version text,
  p_app_version text
) returns table(device_id uuid, room_id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_device_count integer;
begin
  if p_device_id is null or p_owner_id is null or p_room_id is null
    or p_token_digest is null or p_token_digest !~ '^[0-9a-f]{64}$'
    or p_device_public_key is null or p_device_public_key !~ '^[0-9a-f]{64}$'
    or p_device_label is null or pg_catalog.char_length(pg_catalog.btrim(p_device_label)) not between 1 and 80
    or p_platform not in ('windows','macos','linux')
    or pg_catalog.char_length(pg_catalog.coalesce(p_os_version,'')) > 40
    or pg_catalog.char_length(pg_catalog.coalesce(p_app_version,'')) > 40 then
    raise exception 'Invalid desktop companion registration';
  end if;

  if not exists (
    select 1 from public.rooms
    where id = p_room_id and owner_id = p_owner_id
  ) then
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text, 0));

  if exists(select 1 from public.backroom_devices where device_id = p_device_id)
    or exists(select 1 from public.backroom_devices where token_digest = p_token_digest) then
    raise exception 'Desktop device identity already registered';
  end if;

  select pg_catalog.count(*) into v_device_count
  from public.backroom_devices
  where owner_id = p_owner_id and status <> 'revoked';

  if v_device_count >= 5 then
    raise exception 'Desktop device limit reached';
  end if;

  insert into public.backroom_devices (
    device_id, owner_id, token_digest, device_label, platform,
    os_version, app_version, status, approved_at, device_public_key,
    capabilities
  ) values (
    p_device_id, p_owner_id, p_token_digest, pg_catalog.btrim(p_device_label), p_platform,
    pg_catalog.coalesce(p_os_version,''), pg_catalog.coalesce(p_app_version,''),
    'active', pg_catalog.clock_timestamp(), p_device_public_key,
    '{"appDiscovery":true,"separateAppData":false,"embeddedVirtualApp":false,"liveScreen":false,"touchControl":false,"desktopControl":false,"terminalControl":false}'::jsonb
  );

  insert into public.backroom_device_room_bindings(device_id, room_id, owner_id)
  values (p_device_id, p_room_id, p_owner_id);

  insert into public.backroom_device_events(room_id, device_id, actor_type, actor_id, event_type)
  values (p_room_id, p_device_id, 'device', p_device_id::text, 'device_connected');

  return query select p_device_id, p_room_id, 'active'::text;
end;
$function$;

revoke all on function public.register_backroom_desktop_device(uuid,uuid,uuid,text,text,text,text,text,text)
  from public, anon, authenticated;
grant execute on function public.register_backroom_desktop_device(uuid,uuid,uuid,text,text,text,text,text,text)
  to service_role;
