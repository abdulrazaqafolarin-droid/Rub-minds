-- Private, short-lived server-side bindings for hosted Rub Minds MCP sessions.
-- The AI credential is never returned from join_group to the model/client.
create table if not exists public.rub_minds_mcp_sessions (
  session_digest text primary key check (length(session_digest) = 64 and session_digest !~ '[^a-f0-9]'),
  agent_credential_ciphertext text,
  room_id uuid,
  participant_id uuid,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  terminated_at timestamptz,
  rate_window_started_at timestamptz not null default now(),
  rate_request_count integer not null default 0 check (rate_request_count >= 0),
  constraint mcp_session_binding_check check (
    (agent_credential_ciphertext is null and room_id is null and participant_id is null)
    or
    (agent_credential_ciphertext is not null and room_id is not null and participant_id is not null)
  )
);

alter table public.rub_minds_mcp_sessions add column if not exists terminated_at timestamptz;
alter table public.rub_minds_mcp_sessions add column if not exists rate_window_started_at timestamptz not null default now();
alter table public.rub_minds_mcp_sessions add column if not exists rate_request_count integer not null default 0 check (rate_request_count >= 0);
alter table public.rub_minds_mcp_sessions enable row level security;
revoke all on table public.rub_minds_mcp_sessions from anon, authenticated;
grant all on table public.rub_minds_mcp_sessions to service_role;

create index if not exists rub_minds_mcp_sessions_expiry_idx
  on public.rub_minds_mcp_sessions (expires_at);
create index if not exists rub_minds_mcp_sessions_terminated_idx
  on public.rub_minds_mcp_sessions (terminated_at) where terminated_at is not null;

-- Atomic per-session fixed-window rate limiting for all authenticated MCP tool calls.
create or replace function public.consume_mcp_session_rate_limit(
  p_session_digest text,
  p_max_requests integer default 60,
  p_window_seconds integer default 60
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $mcp$
declare
  v_count integer;
begin
  if p_session_digest is null or length(p_session_digest) <> 64 or p_session_digest ~ '[^a-f0-9]' then
    return false;
  end if;
  if p_max_requests < 1 or p_max_requests > 600 or p_window_seconds < 1 or p_window_seconds > 3600 then
    raise exception 'Invalid MCP rate limit parameters';
  end if;

  update public.rub_minds_mcp_sessions as s
  set rate_window_started_at = case
        when s.rate_window_started_at <= pg_catalog.now() - pg_catalog.make_interval(secs => p_window_seconds)
          then pg_catalog.now()
        else s.rate_window_started_at
      end,
      rate_request_count = case
        when s.rate_window_started_at <= pg_catalog.now() - pg_catalog.make_interval(secs => p_window_seconds)
          then 1
        when s.rate_request_count <= p_max_requests
          then s.rate_request_count + 1
        else p_max_requests + 1
      end
  where s.session_digest = p_session_digest
    and s.terminated_at is null
    and s.expires_at > pg_catalog.now()
  returning rate_request_count into v_count;

  return coalesce(v_count <= p_max_requests, false);
end;
$mcp$;

revoke all on function public.consume_mcp_session_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_mcp_session_rate_limit(text, integer, integer) to service_role;

-- Agent request logs are server-managed and have no client-facing policies.
-- Remove direct client grants as defense in depth; privileged database functions
-- and service-role backend operations remain responsible for writing these rows.
revoke all on table public.agent_request_log from anon, authenticated;
