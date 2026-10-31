-- Durable, short-lived command handoff for Android app-window streaming.
-- The enrolled handset is authenticated by its device bearer at the Edge Function;
-- it is deliberately not given a Supabase Auth identity or direct Realtime access.
create table if not exists public.backroom_android_commands (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.backroom_devices(device_id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  session_id uuid not null references public.backroom_desktop_sessions(session_id) on delete cascade,
  request_id uuid not null,
  command jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'leased', 'acked', 'rejected', 'expired')),
  result text,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  expires_at timestamptz not null,
  lease_until timestamptz,
  acked_at timestamptz,
  unique (device_id, request_id),
  check (expires_at > created_at),
  check ((status = 'leased' and lease_until is not null) or status <> 'leased'),
  check ((status = 'acked' and acked_at is not null) or status <> 'acked'),
  check (result is null or length(result) <= 80),
  check (octet_length(command::text) <= 70_000)
);

alter table public.backroom_android_commands enable row level security;
revoke all on table public.backroom_android_commands from public, anon, authenticated;
grant select, insert, update, delete on table public.backroom_android_commands to service_role;

create index if not exists backroom_android_commands_device_pending_idx
  on public.backroom_android_commands(device_id, status, created_at)
  where status in ('pending', 'leased');

create index if not exists backroom_android_commands_expiry_idx
  on public.backroom_android_commands(expires_at);

comment on table public.backroom_android_commands is
  'Service-role-only, expiring Android app-stream/control command queue. Device bearer authentication is enforced by the backroom-device Edge Function.';

-- One handset has one MediaProjection and one screen peer at a time. Make the
-- invariant atomic so requests from two rooms cannot create competing streams.
update public.backroom_desktop_sessions
set status = 'expired', stopped_at = coalesce(stopped_at, pg_catalog.clock_timestamp())
where session_type = 'screen' and status = 'active'
  and expires_at <= pg_catalog.clock_timestamp();

-- If a prior client produced overlapping sessions for the same device, keep
-- the newest active record and retire the older records before adding the
-- uniqueness guarantee. The new runtime supports one screen peer per device.
with ranked as (
  select session_id,
         row_number() over (partition by device_id order by created_at desc, session_id) as position
  from public.backroom_desktop_sessions
  where session_type = 'screen' and status = 'active'
)
update public.backroom_desktop_sessions s
set status = 'expired', stopped_at = coalesce(s.stopped_at, pg_catalog.clock_timestamp())
from ranked r
where s.session_id = r.session_id and r.position > 1;

create unique index if not exists backroom_desktop_sessions_one_active_screen_per_device_idx
  on public.backroom_desktop_sessions(device_id)
  where session_type = 'screen' and status = 'active';
