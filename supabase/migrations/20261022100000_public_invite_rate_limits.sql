-- Shared, atomic fixed-window limits for unauthenticated invitation endpoints.
-- Only keyed digests are stored; raw client IPs never enter the database.
create table if not exists public.public_request_rate_limits (
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  bucket text not null check (bucket in ('ai-invite-discovery', 'redeem-ai-invite', 'rub-minds-mcp-requests', 'rub-minds-mcp-join')),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (key_hash, bucket)
);

alter table public.public_request_rate_limits enable row level security;
revoke all on table public.public_request_rate_limits from public, anon, authenticated;
grant all on table public.public_request_rate_limits to service_role;
create index if not exists public_request_rate_limits_updated_at_idx
  on public.public_request_rate_limits (updated_at);

create or replace function public.consume_public_request_rate_limit(
  p_key_hash text,
  p_bucket text,
  p_limit integer,
  p_window_seconds integer default 60
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $rate$
declare
  current_window timestamptz;
  current_count integer;
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$'
     or p_bucket is null or p_bucket not in ('ai-invite-discovery', 'redeem-ai-invite', 'rub-minds-mcp-requests', 'rub-minds-mcp-join')
     or p_limit is null or p_limit < 1 or p_limit > 1000
     or p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 3600 then
    raise exception 'Invalid public rate-limit parameters';
  end if;

  current_window := to_timestamp(
    floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds
  );

  insert into public.public_request_rate_limits (
    key_hash, bucket, window_started_at, request_count, updated_at
  ) values (
    p_key_hash, p_bucket, current_window, 1, clock_timestamp()
  )
  on conflict (key_hash, bucket) do update
  set window_started_at = excluded.window_started_at,
      request_count = case
        when public.public_request_rate_limits.window_started_at = excluded.window_started_at
          then public.public_request_rate_limits.request_count + 1
        else 1
      end,
      updated_at = clock_timestamp()
  returning request_count into current_count;

  -- Keep a bounded retention horizon without scanning the table on every request.
  if current_count = 1 and pg_catalog.random() < 0.01 then
    delete from public.public_request_rate_limits
    where updated_at < pg_catalog.clock_timestamp() - interval '2 days';
  end if;

  return current_count <= p_limit;
end;
$rate$;

revoke all on function public.consume_public_request_rate_limit(text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_public_request_rate_limit(text, text, integer, integer)
  to service_role;
