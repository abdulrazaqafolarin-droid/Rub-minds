alter table public.rub_minds_mcp_sessions
  add column if not exists agent_credential_digest text;

-- A user-confirmed Auto participation session may remain active for up to 24 hours.
-- The existing binding scope, owner/session checks, row lock, grant idempotency,
-- and atomic queue cancellation remain unchanged.
create or replace function public.activate_backroom_wake_grant(
  p_host_id text,
  p_session_digest text,
  p_binding_id uuid,
  p_grant_id uuid,
  p_ttl_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_binding public.backroom_input_bindings%rowtype;
  v_session public.rub_minds_mcp_sessions%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_host_id is null or p_session_digest is null or p_binding_id is null
    or p_grant_id is null or p_ttl_seconds is null
    or p_ttl_seconds < 60 or p_ttl_seconds > 86400 then
    raise exception 'Invalid Backroom wake grant activation';
  end if;

  -- Match queue admission and Leave lock ordering: session admission lock,
  -- parent MCP session row, then the child Backroom input binding row.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_session_digest, 0)
  );

  select * into v_session
  from public.rub_minds_mcp_sessions s
  where s.session_digest = p_session_digest
    and s.terminated_at is null
    and s.expires_at > v_now
    and s.agent_credential_ciphertext is not null
  for update;
  if not found then return false; end if;

  select * into v_binding
  from public.backroom_input_bindings b
  where b.id = p_binding_id and b.host_id = p_host_id
    and b.session_digest = p_session_digest and b.revoked_at is null
  for update;

  if not found then return false; end if;

  -- Retry of the currently active grant is idempotent and does not extend TTL.
  if v_binding.wake_enabled
    and v_binding.wake_grant_id = p_grant_id
    and v_binding.wake_expires_at > v_now then
    return true;
  end if;

  -- A different active grant must not be overwritten until it is expired or
  -- explicitly deactivated. This prevents racing consent grants from stealing
  -- a binding from each other.
  if v_binding.wake_enabled and v_binding.wake_grant_id is distinct from p_grant_id
    and v_binding.wake_expires_at > v_now then
    return false;
  end if;

  if not exists (
    select 1 from public.backroom_hosts h
    where h.host_id = p_host_id and h.owner_id = v_binding.owner_id
      and h.revoked_at is null and h.expires_at > v_now
  ) then return false; end if;

  if not exists (
    select 1 from public.participants p
    where p.id = v_binding.participant_id and p.room_id = v_binding.room_id
      and p.status in ('connected','active','autonomous')
  ) then return false; end if;

  -- Match the exact invitation credential that this MCP session joined
  -- with; another unexpired connection for the same participant must not extend
  -- this session beyond its own credential's lifetime.
  if v_session.agent_credential_digest is null or
     v_session.agent_credential_digest !~ '^[a-f0-9]{64}

  -- The MCP handle is initially issued with a 24-hour lifetime. The
  -- explicit, owner-approved Auto grant may extend this exact locked live handle,
  -- but never beyond the active AI participant credential/invitation expiry checked
  -- below. The parent row was locked before the child binding to match Leave.
  if v_session.room_id is distinct from v_binding.room_id
    or v_session.participant_id is distinct from v_binding.participant_id then
    return false;
  end if;
  if not exists (
    select 1 from public.agent_connections ac
    where ac.room_id = v_binding.room_id
      and ac.participant_id = v_binding.participant_id
      and ac.owner_id = v_binding.owner_id
      and ac.revoked_at is null
      and ac.expires_at > v_now + pg_catalog.make_interval(secs => p_ttl_seconds)
  ) then return false; end if;

  update public.rub_minds_mcp_sessions
  set expires_at = greatest(expires_at,
        v_now + pg_catalog.make_interval(secs => p_ttl_seconds)),
      last_seen_at = v_now
  where session_digest = p_session_digest
    and terminated_at is null
    and expires_at > v_now
    and agent_credential_ciphertext is not null;
  if not found then return false; end if;

  update public.backroom_input_bindings
  set wake_enabled = true, wake_grant_id = p_grant_id,
      wake_last_revoked_grant_id = null, confirmed_at = v_now,
      wake_expires_at = v_now + pg_catalog.make_interval(secs => p_ttl_seconds),
      updated_at = v_now
  where id = p_binding_id;

  return true;
end;
$function$;

revoke all on function public.activate_backroom_wake_grant(text,text,uuid,uuid,integer) from public, anon, authenticated;
grant execute on function public.activate_backroom_wake_grant(text,text,uuid,uuid,integer) to service_role;
 then
    return false;
  end if;
  if not exists (
    select 1 from public.agent_connections ac
    where ac.credential_digest = v_session.agent_credential_digest
      and ac.room_id = v_binding.room_id
      and ac.participant_id = v_binding.participant_id
      and ac.owner_id = v_binding.owner_id
      and ac.revoked_at is null
      and ac.expires_at > v_now + pg_catalog.make_interval(secs => p_ttl_seconds)
  ) then return false; end if;

  -- The MCP handle is initially issued with a 24-hour lifetime. The
  -- explicit, owner-approved Auto grant may extend this exact locked live handle,
  -- but never beyond the active AI participant credential/invitation expiry checked
  -- below. The parent row was locked before the child binding to match Leave.
  if v_session.room_id is distinct from v_binding.room_id
    or v_session.participant_id is distinct from v_binding.participant_id then
    return false;
  end if;
  if not exists (
    select 1 from public.agent_connections ac
    where ac.room_id = v_binding.room_id
      and ac.participant_id = v_binding.participant_id
      and ac.owner_id = v_binding.owner_id
      and ac.revoked_at is null
      and ac.expires_at > v_now + pg_catalog.make_interval(secs => p_ttl_seconds)
  ) then return false; end if;

  update public.rub_minds_mcp_sessions
  set expires_at = greatest(expires_at,
        v_now + pg_catalog.make_interval(secs => p_ttl_seconds)),
      last_seen_at = v_now
  where session_digest = p_session_digest
    and terminated_at is null
    and expires_at > v_now
    and agent_credential_ciphertext is not null;
  if not found then return false; end if;

  update public.backroom_input_bindings
  set wake_enabled = true, wake_grant_id = p_grant_id,
      wake_last_revoked_grant_id = null, confirmed_at = v_now,
      wake_expires_at = v_now + pg_catalog.make_interval(secs => p_ttl_seconds),
      updated_at = v_now
  where id = p_binding_id;

  return true;
end;
$function$;

revoke all on function public.activate_backroom_wake_grant(text,text,uuid,uuid,integer) from public, anon, authenticated;
grant execute on function public.activate_backroom_wake_grant(text,text,uuid,uuid,integer) to service_role;
