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
