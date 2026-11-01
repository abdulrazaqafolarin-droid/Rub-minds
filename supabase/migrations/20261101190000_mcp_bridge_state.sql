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


-- All bridge-state operations lock the parent MCP session before the child
-- bridge row. This matches leave_group's lock order and prevents a child→parent
-- versus parent→child deadlock during concurrent save/termination.
create or replace function public.load_rub_minds_mcp_bridge_state(
  p_session_digest text,
  p_room_id uuid,
  p_participant_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.rub_minds_mcp_sessions%rowtype;
  v_state public.rub_minds_mcp_bridge_state%rowtype;
begin
  if p_session_digest !~ '^[a-f0-9]{64}$'
     or p_room_id is null
     or p_participant_id is null then
    raise exception using errcode = '22023', message = 'Invalid bridge-state session binding';
  end if;

  select s.*
    into v_session
  from public.rub_minds_mcp_sessions s
  where s.session_digest = p_session_digest
  for update;

  if not found
     or v_session.terminated_at is not null
     or v_session.expires_at <= pg_catalog.clock_timestamp()
     or v_session.room_id is distinct from p_room_id
     or v_session.participant_id is distinct from p_participant_id then
    raise exception using errcode = '28000', message = 'Bridge state requires the current active MCP session binding';
  end if;

  insert into public.rub_minds_mcp_bridge_state(session_digest, room_id, participant_id)
  values (p_session_digest, p_room_id, p_participant_id)
  on conflict (session_digest) do nothing;

  select s.*
    into v_state
  from public.rub_minds_mcp_bridge_state s
  where s.session_digest = p_session_digest;

  if not found
     or v_state.room_id is distinct from p_room_id
     or v_state.participant_id is distinct from p_participant_id then
    raise exception using errcode = '23514', message = 'Stored bridge state does not match the active session binding';
  end if;

  return pg_catalog.jsonb_build_object(
    'revision', v_state.revision,
    'cursor', case
      when v_state.cursor_created_at is not null and v_state.cursor_message_id is not null
      then pg_catalog.jsonb_build_object(
        'after_created_at', v_state.cursor_created_at,
        'after_message_id', v_state.cursor_message_id
      )
      else null
    end,
    'pending_response', case
      when v_state.pending_message_id is not null
      then pg_catalog.jsonb_build_object(
        'source_message_id', v_state.pending_message_id,
        'message_created_at', v_state.pending_message_created_at,
        'body', v_state.pending_response
      )
      else null
    end,
    'blocked_message', case
      when v_state.blocked_message_id is not null
      then pg_catalog.jsonb_build_object(
        'message_id', v_state.blocked_message_id,
        'reason', v_state.blocked_reason
      )
      else null
    end,
    'updated_at', v_state.updated_at
  );
end;
$$;

create or replace function public.save_rub_minds_mcp_bridge_state(
  p_session_digest text,
  p_room_id uuid,
  p_participant_id uuid,
  p_expected_revision bigint,
  p_cursor_created_at timestamptz,
  p_cursor_message_id uuid,
  p_pending_message_id uuid,
  p_pending_message_created_at timestamptz,
  p_pending_response text,
  p_blocked_message_id uuid,
  p_blocked_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.rub_minds_mcp_sessions%rowtype;
  v_revision bigint;
begin
  if p_session_digest !~ '^[a-f0-9]{64}$'
     or p_room_id is null
     or p_participant_id is null
     or p_expected_revision is null
     or p_expected_revision < 0 then
    raise exception using errcode = '22023', message = 'Invalid bridge-state save binding or revision';
  end if;

  select s.*
    into v_session
  from public.rub_minds_mcp_sessions s
  where s.session_digest = p_session_digest
  for update;

  if not found
     or v_session.terminated_at is not null
     or v_session.expires_at <= pg_catalog.clock_timestamp()
     or v_session.room_id is distinct from p_room_id
     or v_session.participant_id is distinct from p_participant_id then
    raise exception using errcode = '28000', message = 'Bridge state requires the current active MCP session binding';
  end if;

  update public.rub_minds_mcp_bridge_state s
  set cursor_created_at = p_cursor_created_at,
      cursor_message_id = p_cursor_message_id,
      pending_message_id = p_pending_message_id,
      pending_message_created_at = p_pending_message_created_at,
      pending_response = p_pending_response,
      blocked_message_id = p_blocked_message_id,
      blocked_reason = p_blocked_reason,
      revision = s.revision + 1,
      updated_at = pg_catalog.clock_timestamp()
  where s.session_digest = p_session_digest
    and s.room_id = p_room_id
    and s.participant_id = p_participant_id
    and s.revision = p_expected_revision
  returning s.revision into v_revision;

  if found then
    return pg_catalog.jsonb_build_object('saved', true, 'conflict', false, 'revision', v_revision);
  end if;

  select s.revision
    into v_revision
  from public.rub_minds_mcp_bridge_state s
  where s.session_digest = p_session_digest
    and s.room_id = p_room_id
    and s.participant_id = p_participant_id;

  if found then
    return pg_catalog.jsonb_build_object('saved', false, 'conflict', true, 'revision', v_revision);
  end if;

  return pg_catalog.jsonb_build_object('saved', false, 'conflict', true, 'revision', null);
end;
$$;

revoke all on function public.load_rub_minds_mcp_bridge_state(text, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.save_rub_minds_mcp_bridge_state(text, uuid, uuid, bigint, timestamptz, uuid, uuid, timestamptz, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.load_rub_minds_mcp_bridge_state(text, uuid, uuid) to service_role;
grant execute on function public.save_rub_minds_mcp_bridge_state(text, uuid, uuid, bigint, timestamptz, uuid, uuid, timestamptz, text, uuid, text) to service_role;
