-- Initial private Realtime authorization for the account-owned desktop companion.
-- The next migration adds group-member access to this same topic, while keeping
-- exact device, active-state and non-revoked room-binding checks.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create or replace function private.can_access_backroom_desktop_realtime_topic()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.backroom_devices d
    join public.backroom_device_room_bindings b on b.device_id = d.device_id
    where realtime.topic() = 'backroom-device:' || d.device_id::text
      and d.owner_id = (select auth.uid())
      and d.status = 'active'
      and b.revoked_at is null
  );
$function$;

revoke all on function private.can_access_backroom_desktop_realtime_topic()
  from public, anon;
grant execute on function private.can_access_backroom_desktop_realtime_topic()
  to authenticated;

drop policy if exists "backroom_desktop_owner_receive_private_broadcast"
  on realtime.messages;
create policy "backroom_desktop_owner_receive_private_broadcast"
  on realtime.messages
  for select
  to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and (select private.can_access_backroom_desktop_realtime_topic())
  );

drop policy if exists "backroom_desktop_owner_send_private_broadcast"
  on realtime.messages;
create policy "backroom_desktop_owner_send_private_broadcast"
  on realtime.messages
  for insert
  to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and (select private.can_access_backroom_desktop_realtime_topic())
  );
