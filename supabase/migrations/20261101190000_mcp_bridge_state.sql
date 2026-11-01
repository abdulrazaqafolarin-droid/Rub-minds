-- Durable, room-scoped state for the optional local original-session wake bridge.
-- State is private to one hosted MCP session handle, never exposed to anon/authenticated clients.
create table if not exists public.rub_minds_mcp_bridge_state (
  session_digest text primary key references public.rub_minds_mcp_sessions(session_digest) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  cursor_created_at timestamptz,
  cursor_message_id uuid,
  pending_message_id uuid,
  pending_message_created_at timestamptz,
  pending_response text,
  blocked_message_id uuid,
  blocked_reason text,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now(),
  constraint mcp_bridge_cursor_pair_check check (
    (cursor_created_at is null and cursor_message_id is null)
    or (cursor_created_at is not null and cursor_message_id is not null)
  ),
  constraint mcp_bridge_pending_pair_check check (
    (pending_message_id is null and pending_message_created_at is null and pending_response is null)
    or (
      pending_message_id is not null and pending_message_created_at is not null
      and pending_response is not null
      and char_length(btrim(pending_response)) between 1 and 10000
    )
  ),
  constraint mcp_bridge_blocked_pair_check check (
    (blocked_message_id is null and blocked_reason is null)
    or (
      blocked_message_id is not null and blocked_reason is not null
      and char_length(btrim(blocked_reason)) between 1 and 200
    )
  ),
  constraint mcp_bridge_pending_blocked_exclusive_check check (
    pending_message_id is null or blocked_message_id is null
  )
);

alter table public.rub_minds_mcp_bridge_state enable row level security;
revoke all on table public.rub_minds_mcp_bridge_state from public, anon, authenticated;
grant all on table public.rub_minds_mcp_bridge_state to service_role;

create index if not exists rub_minds_mcp_bridge_state_room_updated_idx
  on public.rub_minds_mcp_bridge_state(room_id, updated_at desc);


-- Serialize bridge-state inserts/updates against session termination and
-- re-joining. A bridge request that races with leave must never recreate state
-- after the session has been tombstoned or rebound to another room/participant.
create or replace function public.enforce_rub_minds_mcp_bridge_state_binding()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.rub_minds_mcp_sessions%rowtype;
begin
  select s.*
    into v_session
  from public.rub_minds_mcp_sessions s
  where s.session_digest = new.session_digest
  for update;

  if not found
     or v_session.terminated_at is not null
     or v_session.expires_at <= pg_catalog.clock_timestamp()
     or v_session.room_id is distinct from new.room_id
     or v_session.participant_id is distinct from new.participant_id then
    raise exception using
      errcode = '23514',
      message = 'Bridge state requires the current active MCP session binding';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_rub_minds_mcp_bridge_state_binding()
  from public, anon, authenticated;

drop trigger if exists rub_minds_mcp_bridge_state_binding_guard
  on public.rub_minds_mcp_bridge_state;

create trigger rub_minds_mcp_bridge_state_binding_guard
before insert or update on public.rub_minds_mcp_bridge_state
for each row
execute function public.enforce_rub_minds_mcp_bridge_state_binding();
