-- Server-authorized desktop sessions and device-only command publishing.
-- Group members authenticate to the Edge Function. Only the enrolled device owner
-- may publish directly to the device's private Realtime channel.
create table if not exists public.backroom_desktop_sessions (
  session_id uuid primary key,
  device_id uuid not null references public.backroom_devices(device_id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete cascade,
  session_type text not null check (session_type in ('screen','terminal')),
  status text not null default 'active' check (status in ('active','stopped','revoked','expired')),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  expires_at timestamptz not null,
  stopped_at timestamptz,
  check (expires_at > created_at),
  check ((status='active' and stopped_at is null) or status<>'active')
);
alter table public.backroom_desktop_sessions enable row level security;
revoke all on table public.backroom_desktop_sessions from public,anon,authenticated;
grant select,insert,update on table public.backroom_desktop_sessions to service_role;
create index if not exists backroom_desktop_sessions_device_room_active_idx
  on public.backroom_desktop_sessions(device_id,room_id,status,expires_at);
create index if not exists backroom_desktop_sessions_requester_idx
  on public.backroom_desktop_sessions(requested_by,created_at desc);

-- An authenticated client may receive responses/signals only if it is the
-- enrolled device owner or an active human member of the bound room.
-- Commands are sent from the server with its privileged Realtime REST sender;
-- clients must not spoof a group-member identity by broadcasting directly.
create or replace function private.can_send_backroom_desktop_realtime_topic()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.backroom_devices d
    join public.backroom_device_room_bindings b on b.device_id=d.device_id
    where realtime.topic()='backroom-device:'||d.device_id::text
      and d.owner_id=(select auth.uid())
      and d.status='active'
      and b.revoked_at is null
  );
$function$;
revoke all on function private.can_send_backroom_desktop_realtime_topic() from public,anon;
grant execute on function private.can_send_backroom_desktop_realtime_topic() to authenticated;

drop policy if exists "backroom_desktop_room_member_send_private_broadcast" on realtime.messages;
drop policy if exists "backroom_desktop_owner_send_private_broadcast" on realtime.messages;
create policy "backroom_desktop_device_owner_send_private_broadcast"
on realtime.messages for insert to authenticated
with check (
  realtime.messages.extension='broadcast'
  and (select private.can_send_backroom_desktop_realtime_topic())
);
