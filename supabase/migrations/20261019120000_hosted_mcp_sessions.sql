-- Private, short-lived server-side bindings for hosted Rub Minds MCP sessions.
-- The AI credential is never returned from join_group to the model/client.
create table if not exists public.rub_minds_mcp_sessions (
  session_digest text primary key check (session_digest ~ '^[a-f0-9]{64}$'),
  agent_credential text,
  room_id uuid,
  participant_id uuid,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  constraint mcp_session_binding_check check (
    (agent_credential is null and room_id is null and participant_id is null)
    or
    (agent_credential is not null and room_id is not null and participant_id is not null)
  )
);

alter table public.rub_minds_mcp_sessions enable row level security;
revoke all on table public.rub_minds_mcp_sessions from anon, authenticated;
grant all on table public.rub_minds_mcp_sessions to service_role;

create index if not exists rub_minds_mcp_sessions_expiry_idx
  on public.rub_minds_mcp_sessions (expires_at);
