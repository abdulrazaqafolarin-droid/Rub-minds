-- RETURNS TABLE declares output variables named device_id, owner_id and
-- room_id. Every table reference to those names must be qualified to avoid
-- PL/pgSQL's ambiguous-column error during a real device claim.
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

  select pairing.* into v_pairing
  from public.backroom_device_pairings as pairing
  where pairing.code_digest = p_code_digest
    and pairing.claimed_at is null
    and pairing.expires_at > pg_catalog.clock_timestamp()
  for update;
  if not found then return; end if;

  if exists (
      select 1 from public.backroom_devices as existing_device
      where existing_device.token_digest = p_token_digest
    )
    or exists (
      select 1 from public.backroom_devices as existing_device
      where existing_device.device_id = p_device_id
    ) then
    raise exception 'Device credential already exists';
  end if;

  if not exists (
    select 1 from public.rooms as room
    where room.id = v_pairing.room_id
      and room.owner_id = v_pairing.owner_id
  ) then
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_pairing.owner_id::text, 0)
  );

  select pg_catalog.count(*) into v_device_count
  from public.backroom_devices as existing_device
  where existing_device.owner_id = v_pairing.owner_id
    and existing_device.status <> 'revoked';
  if v_device_count >= 5 then return; end if;

  insert into public.backroom_devices(
    device_id, owner_id, token_digest, device_label, platform,
    os_version, app_version, status
  ) values (
    p_device_id, v_pairing.owner_id, p_token_digest, btrim(p_device_label),
    'android', coalesce(p_os_version,''), coalesce(p_app_version,''), 'pending'
  );

  insert into public.backroom_device_room_bindings(device_id, room_id, owner_id)
  values (p_device_id, v_pairing.room_id, v_pairing.owner_id);

  update public.backroom_device_pairings
  set claimed_at = pg_catalog.clock_timestamp(), device_id = p_device_id
  where id = v_pairing.id and claimed_at is null;

  insert into public.backroom_device_events(
    room_id, device_id, actor_type, actor_id, event_type
  ) values (
    v_pairing.room_id, p_device_id, 'device', p_device_id::text, 'device_paired'
  );

  return query select p_device_id, v_pairing.owner_id, v_pairing.room_id;
end;
$function$;

revoke all on function public.claim_backroom_device_pairing(text,uuid,text,text,text,text)
  from public, anon, authenticated;
grant execute on function public.claim_backroom_device_pairing(text,uuid,text,text,text,text)
  to service_role;
