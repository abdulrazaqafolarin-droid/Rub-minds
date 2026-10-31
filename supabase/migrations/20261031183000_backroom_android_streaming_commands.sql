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
