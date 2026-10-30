-- Bind private broadcast authorization to both the exact device topic and room.
-- The device owner and active human group members may send requests. The companion
-- still displays a local approval for every launch/view/control/draft action.
create or replace function private.can_access_backroom_desktop_realtime_topic(p_room_id text)
returns boolean
language sql stable security definer set search_path=''
as $function$
  select p_room_id is not null and exists (
    select 1
    from public.backroom_devices d
    join public.backroom_device_room_bindings b on b.device_id=d.device_id
    where realtime.topic()='backroom-device:'||d.device_id::text
      and b.room_id::text=p_room_id
      and d.status='active'
      and b.revoked_at is null
      and (
        d.owner_id=(select auth.uid())
        or exists(
          select 1 from public.participants p
          where p.room_id=b.room_id and p.user_id=(select auth.uid())
            and p.kind='human' and p.status in ('active','connected','autonomous')
        )
      )
  );
$function$;
revoke all on function private.can_access_backroom_desktop_realtime_topic(text) from public,anon;
grant execute on function private.can_access_backroom_desktop_realtime_topic(text) to authenticated;
drop policy if exists "backroom_desktop_owner_receive_private_broadcast" on realtime.messages;
drop policy if exists "backroom_desktop_owner_send_private_broadcast" on realtime.messages;
drop policy if exists "backroom_desktop_room_member_receive_private_broadcast" on realtime.messages;
drop policy if exists "backroom_desktop_room_member_send_private_broadcast" on realtime.messages;
create policy "backroom_desktop_room_member_receive_private_broadcast" on realtime.messages
  for select to authenticated
  using (realtime.messages.extension='broadcast'
    and (select private.can_access_backroom_desktop_realtime_topic(realtime.messages.payload->>'roomId')));
create policy "backroom_desktop_room_member_send_private_broadcast" on realtime.messages
  for insert to authenticated
  with check (realtime.messages.extension='broadcast'
    and (select private.can_access_backroom_desktop_realtime_topic(realtime.messages.payload->>'roomId')));
