-- Add durable, independent task-event recovery to the original-session bridge.
-- Reuse the existing session-bound state row so Leave/rejoin cleanup stays atomic.
alter table public.rub_minds_mcp_bridge_state
  add column if not exists active_task_id uuid,
  add column if not exists pending_task_result text,
  add column if not exists pending_task_submission_key uuid,
  add column if not exists blocked_task_reason text,
  add column if not exists task_revision bigint not null default 0;

alter table public.rub_minds_mcp_bridge_state
  drop constraint if exists mcp_bridge_task_revision_check,
  drop constraint if exists mcp_bridge_task_pending_pair_check,
  drop constraint if exists mcp_bridge_task_recovery_check;

alter table public.rub_minds_mcp_bridge_state
  add constraint mcp_bridge_task_revision_check
    check (task_revision >= 0),
  add constraint mcp_bridge_task_pending_pair_check
    check (
      (pending_task_result is null and pending_task_submission_key is null)
      or (
        active_task_id is not null
        and pending_task_result is not null
        and char_length(btrim(pending_task_result)) between 1 and 20000
        and pending_task_submission_key is not null
        and blocked_task_reason is null
      )
    ),
  add constraint mcp_bridge_task_recovery_check
    check (
      (active_task_id is null
        and pending_task_result is null
        and pending_task_submission_key is null
        and blocked_task_reason is null)
      or
      (active_task_id is not null
        and pending_task_result is null
        and pending_task_submission_key is null
        and blocked_task_reason is not null
        and char_length(btrim(blocked_task_reason)) between 1 and 200)
      or
      (active_task_id is not null
        and pending_task_result is not null
        and pending_task_submission_key is not null
        and blocked_task_reason is null
        and char_length(btrim(pending_task_result)) between 1 and 20000)
    );

create or replace function public.load_rub_minds_mcp_task_bridge_state(
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
    raise exception using errcode = '22023', message = 'Invalid task bridge-state session binding';
  end if;

  -- Keep the same parent-first lock order as message bridge state, Leave and rejoin.
  select s.* into v_session
  from public.rub_minds_mcp_sessions s
  where s.session_digest = p_session_digest
  for update;

  if not found
     or v_session.terminated_at is not null
     or v_session.expires_at <= pg_catalog.clock_timestamp()
     or v_session.room_id is distinct from p_room_id
     or v_session.participant_id is distinct from p_participant_id then
    raise exception using errcode = '28000', message = 'Task bridge state requires the current active MCP session binding';
  end if;

  insert into public.rub_minds_mcp_bridge_state(session_digest, room_id, participant_id)
  values (p_session_digest, p_room_id, p_participant_id)
  on conflict (session_digest) do nothing;

  select s.* into v_state
  from public.rub_minds_mcp_bridge_state s
  where s.session_digest = p_session_digest;

  if not found
     or v_state.room_id is distinct from p_room_id
     or v_state.participant_id is distinct from p_participant_id then
    raise exception using errcode = '23514', message = 'Stored task bridge state does not match the active session binding';
  end if;

  return pg_catalog.jsonb_build_object(
    'revision', v_state.task_revision,
    'active_task_id', v_state.active_task_id,
    'pending_result', v_state.pending_task_result,
    'pending_submission_key', v_state.pending_task_submission_key,
    'blocked_reason', v_state.blocked_task_reason
  );
end;
$$;

create or replace function public.save_rub_minds_mcp_task_bridge_state(
  p_session_digest text,
  p_room_id uuid,
  p_participant_id uuid,
  p_expected_revision bigint,
  p_active_task_id uuid,
  p_pending_result text,
  p_pending_submission_key uuid,
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
  v_is_empty boolean;
  v_is_blocked boolean;
  v_is_pending boolean;
begin
  if p_session_digest !~ '^[a-f0-9]{64}$'
     or p_room_id is null
     or p_participant_id is null
     or p_expected_revision is null
     or p_expected_revision < 0 then
    raise exception using errcode = '22023', message = 'Invalid task bridge-state binding or revision';
  end if;

  v_is_empty := p_active_task_id is null
    and p_pending_result is null
    and p_pending_submission_key is null
    and p_blocked_reason is null;
  v_is_blocked := p_active_task_id is not null
    and p_pending_result is null
    and p_pending_submission_key is null
    and p_blocked_reason is not null
    and char_length(btrim(p_blocked_reason)) between 1 and 200;
  v_is_pending := p_active_task_id is not null
    and p_pending_result is not null
    and char_length(btrim(p_pending_result)) between 1 and 20000
    and p_pending_submission_key is not null
    and p_blocked_reason is null;

  if not (v_is_empty or v_is_blocked or v_is_pending) then
    raise exception using errcode = '22023', message = 'Invalid task bridge recovery state';
  end if;

  select s.* into v_session
  from public.rub_minds_mcp_sessions s
  where s.session_digest = p_session_digest
  for update;

  if not found
     or v_session.terminated_at is not null
     or v_session.expires_at <= pg_catalog.clock_timestamp()
     or v_session.room_id is distinct from p_room_id
     or v_session.participant_id is distinct from p_participant_id then
    raise exception using errcode = '28000', message = 'Task bridge state requires the current active MCP session binding';
  end if;

  update public.rub_minds_mcp_bridge_state s
  set active_task_id = p_active_task_id,
      pending_task_result = p_pending_result,
      pending_task_submission_key = p_pending_submission_key,
      blocked_task_reason = p_blocked_reason,
      task_revision = s.task_revision + 1,
      updated_at = pg_catalog.clock_timestamp()
  where s.session_digest = p_session_digest
    and s.room_id = p_room_id
    and s.participant_id = p_participant_id
    and s.task_revision = p_expected_revision
  returning s.task_revision into v_revision;

  if found then
    return pg_catalog.jsonb_build_object('saved', true, 'conflict', false, 'revision', v_revision);
  end if;

  select s.task_revision into v_revision
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

revoke all on function public.load_rub_minds_mcp_task_bridge_state(text, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.save_rub_minds_mcp_task_bridge_state(text, uuid, uuid, bigint, uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.load_rub_minds_mcp_task_bridge_state(text, uuid, uuid)
  to service_role;
grant execute on function public.save_rub_minds_mcp_task_bridge_state(text, uuid, uuid, bigint, uuid, text, uuid, text)
  to service_role;
