-- Leaving a Rub Minds group must revoke that exact MCP session's Backroom
-- composer authorization and cancel its pending/leased wake jobs atomically.
-- Queue admission takes the same per-session advisory lock, so no enqueue can
-- pass authorization concurrently and appear after this cleanup.
create or replace function public.terminate_rub_minds_mcp_bridge_session(
  p_session_digest text,
  p_expected_ciphertext text,
  p_credential_digest text,
  p_tombstone_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.rub_minds_mcp_sessions%rowtype;
  v_terminated_at timestamptz;
begin
  if p_session_digest !~ '^[a-f0-9]{64}$'
     or p_tombstone_expires_at is null
     or p_tombstone_expires_at <= pg_catalog.clock_timestamp()
     or ((p_expected_ciphertext is null) <> (p_credential_digest is null))
     or (p_expected_ciphertext is not null and
         (pg_catalog.length(p_expected_ciphertext) < 1
          or p_credential_digest !~ '^[a-f0-9]{64}$')) then
    raise exception using errcode = '22023', message = 'Invalid MCP bridge session termination parameters';
  end if;

  -- Match enqueue_backroom_wake_job's admission lock. This serializes Leave
  -- against a concurrent Realtime-triggered wake enqueue for the same session.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_session_digest, 0)
  );

  select s.*
    into v_session
  from public.rub_minds_mcp_sessions s
  where s.session_digest = p_session_digest
  for update;

  if not found then
    return pg_catalog.jsonb_build_object(
      'terminated', false, 'already_terminated', false, 'not_found', true, 'conflict', false
    );
  end if;

  if v_session.terminated_at is not null then
    v_terminated_at := v_session.terminated_at;
    update public.backroom_input_bindings
    set wake_enabled = false,
        wake_last_revoked_grant_id = coalesce(wake_grant_id, wake_last_revoked_grant_id),
        wake_grant_id = null, confirmed_at = null, wake_expires_at = null,
        revoked_at = coalesce(revoked_at, v_terminated_at), updated_at = v_terminated_at
    where session_digest = p_session_digest and revoked_at is null;
    update public.backroom_wake_jobs
    set state = 'cancelled', lease_owner = null, lease_token_hash = null,
        lease_expires_at = null, last_error_code = 'authorization_denied',
        updated_at = v_terminated_at
    where session_digest = p_session_digest and state in ('pending','leased');
    delete from public.rub_minds_mcp_bridge_state
    where session_digest = p_session_digest;
    return pg_catalog.jsonb_build_object(
      'terminated', true, 'already_terminated', true, 'not_found', false, 'conflict', false
    );
  end if;

  if v_session.agent_credential_ciphertext is distinct from p_expected_ciphertext then
    return pg_catalog.jsonb_build_object(
      'terminated', false, 'already_terminated', false, 'not_found', false, 'conflict', true
    );
  end if;

  if p_credential_digest is not null then
    update public.agent_connections
    set revoked_at = pg_catalog.clock_timestamp()
    where credential_digest = p_credential_digest
      and revoked_at is null;
  end if;

  v_terminated_at := pg_catalog.clock_timestamp();

  -- Mark bindings revoked, not merely wake-disabled. A local host's next
  -- authenticated claim will then receive 401 and stop its in-memory poller.
  update public.backroom_input_bindings
  set wake_enabled = false,
      wake_last_revoked_grant_id = coalesce(wake_grant_id, wake_last_revoked_grant_id),
      wake_grant_id = null, confirmed_at = null, wake_expires_at = null,
      revoked_at = coalesce(revoked_at, v_terminated_at), updated_at = v_terminated_at
  where session_digest = p_session_digest and revoked_at is null;

  update public.backroom_wake_jobs
  set state = 'cancelled', lease_owner = null, lease_token_hash = null,
      lease_expires_at = null, last_error_code = 'authorization_denied',
      updated_at = v_terminated_at
  where session_digest = p_session_digest and state in ('pending','leased');

  update public.rub_minds_mcp_sessions
  set agent_credential_ciphertext = null,
      room_id = null,
      participant_id = null,
      terminated_at = v_terminated_at,
      expires_at = p_tombstone_expires_at,
      last_seen_at = v_terminated_at
  where session_digest = p_session_digest
    and agent_credential_ciphertext is not distinct from p_expected_ciphertext
    and terminated_at is null;

  if not found then
    raise exception using errcode = '40001', message = 'MCP session changed during atomic termination';
  end if;

  delete from public.rub_minds_mcp_bridge_state
  where session_digest = p_session_digest;

  return pg_catalog.jsonb_build_object(
    'terminated', true, 'already_terminated', false, 'not_found', false, 'conflict', false
  );
end;
$$;

revoke all on function public.terminate_rub_minds_mcp_bridge_session(text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.terminate_rub_minds_mcp_bridge_session(text, text, text, timestamptz)
  to service_role;
