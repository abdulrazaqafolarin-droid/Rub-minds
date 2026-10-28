-- Durable, private Backroom wake queue. No provider cookies, credentials or raw conversation URLs.
create table if not exists public.backroom_wake_jobs (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  job_key text not null unique check (job_key ~ '^[0-9a-f]{64}$'),
  owner_id uuid not null,
  room_id uuid not null,
  participant_id uuid not null,
  host_id text not null check (char_length(btrim(host_id)) between 1 and 128),
  space_id text not null check (char_length(btrim(space_id)) between 1 and 128),
  session_id text not null check (char_length(btrim(session_id)) between 1 and 256),
  session_digest text not null check (session_digest ~ '^[0-9a-f]{64}$'),
  binding_id text not null check (char_length(btrim(binding_id)) between 1 and 128),
  target_id text not null check (char_length(btrim(target_id)) between 1 and 128),
  target_identity_fingerprint text not null check (char_length(btrim(target_identity_fingerprint)) between 1 and 512),
  target_revision integer not null check (target_revision > 0),
  event_id text not null check (char_length(btrim(event_id)) between 1 and 256),
  operation text not null default 'draft' check (operation = 'draft'),
  prompt text not null check (
    char_length(prompt) between 13 and 12000
    and pg_catalog.left(prompt, 12) = '@RMconnects' || pg_catalog.chr(10)
  ),
  prompt_digest text not null check (prompt_digest ~ '^[0-9a-f]{64}$'),
  state text not null default 'pending' check (
    state in ('pending','leased','acknowledged','ignored','failed','cancelled','expired')
  ),
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  available_at timestamptz not null default pg_catalog.clock_timestamp(),
  lease_owner text,
  lease_token_hash text check (lease_token_hash is null or lease_token_hash ~ '^[0-9a-f]{64}$'),
  lease_expires_at timestamptz,
  expires_at timestamptz not null default (pg_catalog.clock_timestamp() + interval '1 hour'),
  acknowledged_at timestamptz,
  last_error_code text check (last_error_code is null or last_error_code in (
    'target_unavailable','approval_required','provider_busy','transport_error',
    'result_unconfirmed','authorization_denied','max_attempts','other'
  )),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint backroom_wake_lease_state_check check (
    (state = 'leased' and lease_owner is not null and lease_token_hash is not null and lease_expires_at is not null)
    or (state <> 'leased' and lease_owner is null and lease_token_hash is null and lease_expires_at is null)
  )
);

alter table public.backroom_wake_jobs enable row level security;
revoke all on table public.backroom_wake_jobs from public, anon, authenticated;
grant all on table public.backroom_wake_jobs to service_role;

create index if not exists backroom_wake_pending_idx
  on public.backroom_wake_jobs (host_id, session_digest, available_at, created_at)
  where state = 'pending';
create index if not exists backroom_wake_lease_expiry_idx
  on public.backroom_wake_jobs (host_id, session_digest, lease_expires_at)
  where state = 'leased';
create index if not exists backroom_wake_expiry_idx
  on public.backroom_wake_jobs (expires_at)
  where state in ('pending','leased');

-- The only supported enqueue path validates every field and makes retries idempotent.
create or replace function public.enqueue_backroom_wake_job(
  p_job_key text,
  p_owner_id uuid,
  p_room_id uuid,
  p_participant_id uuid,
  p_host_id text,
  p_space_id text,
  p_session_id text,
  p_session_digest text,
  p_binding_id text,
  p_target_id text,
  p_target_identity_fingerprint text,
  p_target_revision integer,
  p_event_id text,
  p_prompt text,
  p_ttl_seconds integer default 3600
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $wake$
declare
  v_id uuid;
  v_existing public.backroom_wake_jobs%rowtype;
  v_prompt_digest text;
begin
  if p_job_key is null or p_job_key !~ '^[0-9a-f]{64}$'
    or p_session_digest is null or p_session_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid idempotency or session digest';
  end if;
  if p_owner_id is null or p_room_id is null or p_participant_id is null then
    raise exception 'Owner, room and participant are required';
  end if;
  if p_host_id is null or char_length(btrim(p_host_id)) not between 1 and 128
    or p_space_id is null or char_length(btrim(p_space_id)) not between 1 and 128
    or p_session_id is null or char_length(btrim(p_session_id)) not between 1 and 256
    or p_binding_id is null or char_length(btrim(p_binding_id)) not between 1 and 128
    or p_target_id is null or char_length(btrim(p_target_id)) not between 1 and 128
    or p_target_identity_fingerprint is null or char_length(btrim(p_target_identity_fingerprint)) not between 1 and 512
    or p_event_id is null or char_length(btrim(p_event_id)) not between 1 and 256
    or p_target_revision is null or p_target_revision < 1 then
    raise exception 'Invalid Backroom target binding';
  end if;
  -- Only a live, joined hosted MCP session bound to this exact group participant may enqueue.
  if not exists (
    select 1 from public.rub_minds_mcp_sessions s
    where s.session_digest = p_session_digest and s.room_id = p_room_id
      and s.participant_id = p_participant_id and s.agent_credential_ciphertext is not null
      and s.terminated_at is null and s.expires_at > pg_catalog.clock_timestamp()
  ) then
    raise exception 'Active MCP session does not authorize this group participant';
  end if;

  if p_ttl_seconds is null or p_ttl_seconds < 60 or p_ttl_seconds > 86400 then
    raise exception 'Wake TTL must be between 60 and 86400 seconds';
  end if;
  if p_prompt is null or char_length(p_prompt) not between 13 and 12000
    or pg_catalog.left(p_prompt, 12) <> '@RMconnects' || pg_catalog.chr(10) then
    raise exception 'Invalid Backroom wake prompt';
  end if;

  v_prompt_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_prompt, 'UTF8')), 'hex');

  insert into public.backroom_wake_jobs (
    job_key, owner_id, room_id, participant_id, host_id, space_id, session_id,
    session_digest, binding_id, target_id, target_identity_fingerprint, target_revision, event_id, prompt,
    prompt_digest, expires_at
  ) values (
    p_job_key, p_owner_id, p_room_id, p_participant_id, p_host_id, p_space_id, p_session_id,
    p_session_digest, p_binding_id, p_target_id, p_target_identity_fingerprint, p_target_revision, p_event_id, p_prompt,
    v_prompt_digest, pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_ttl_seconds)
  )
  on conflict (job_key) do nothing
  returning id into v_id;

  if found then
    return pg_catalog.jsonb_build_object('job_id', v_id, 'created', true, 'state', 'pending');
  end if;

  select * into v_existing from public.backroom_wake_jobs where job_key = p_job_key;
  if not found then
    raise exception 'Wake idempotency conflict could not be resolved';
  end if;
  if v_existing.owner_id is distinct from p_owner_id
    or v_existing.room_id is distinct from p_room_id
    or v_existing.participant_id is distinct from p_participant_id
    or v_existing.host_id is distinct from p_host_id
    or v_existing.space_id is distinct from p_space_id
    or v_existing.session_id is distinct from p_session_id
    or v_existing.session_digest is distinct from p_session_digest
    or v_existing.binding_id is distinct from p_binding_id
    or v_existing.target_id is distinct from p_target_id
    or v_existing.target_identity_fingerprint is distinct from p_target_identity_fingerprint
    or v_existing.target_revision is distinct from p_target_revision
    or v_existing.event_id is distinct from p_event_id
    or v_existing.prompt_digest is distinct from v_prompt_digest then
    raise exception 'Wake idempotency key conflicts with a different request';
  end if;
  return pg_catalog.jsonb_build_object('job_id', v_existing.id, 'created', false, 'state', v_existing.state);
end;
$wake$;

-- Claims use row locks and SKIP LOCKED, so concurrent workers cannot claim the same job.
-- The plaintext lease token is returned to the trusted backend only; only its digest is stored.
create or replace function public.claim_backroom_wake_jobs(
  p_host_id text,
  p_session_digest text,
  p_limit integer default 5,
  p_lease_seconds integer default 30
)
returns table (
  out_job_id uuid,
  out_job_key text,
  out_event_id text,
  out_owner_id uuid,
  out_room_id uuid,
  out_participant_id uuid,
  out_space_id text,
  out_session_id text,
  out_binding_id text,
  out_target_id text,
  out_target_identity_fingerprint text,
  out_target_revision integer,
  out_prompt text,
  out_prompt_digest text,
  out_attempt_count integer,
  out_expires_at timestamptz,
  out_lease_token text
)
language plpgsql
security definer
set search_path = ''
as $claim$
begin
  if p_host_id is null or char_length(btrim(p_host_id)) not between 1 and 128
    or p_session_digest is null or p_session_digest !~ '^[0-9a-f]{64}$'
    or p_limit is null or p_limit < 1 or p_limit > 20
    or p_lease_seconds is null or p_lease_seconds < 10 or p_lease_seconds > 120 then
    raise exception 'Invalid Backroom claim parameters';
  end if;

  if not exists (
    select 1 from public.rub_minds_mcp_sessions s
    where s.session_digest = p_session_digest and s.agent_credential_ciphertext is not null
      and s.terminated_at is null and s.expires_at > pg_catalog.clock_timestamp()
  ) then
    return;
  end if;

  update public.backroom_wake_jobs j
  set state = 'expired', lease_owner = null, lease_token_hash = null, lease_expires_at = null,
      updated_at = pg_catalog.clock_timestamp()
  where j.host_id = p_host_id and j.session_digest = p_session_digest
    and j.state in ('pending','leased') and j.expires_at <= pg_catalog.clock_timestamp();

  update public.backroom_wake_jobs j
  set state = 'failed', lease_owner = null, lease_token_hash = null, lease_expires_at = null,
      last_error_code = 'max_attempts', updated_at = pg_catalog.clock_timestamp()
  where j.host_id = p_host_id and j.session_digest = p_session_digest
    and j.state = 'leased' and j.lease_expires_at <= pg_catalog.clock_timestamp()
    and j.attempt_count >= 5;

  return query
  with candidates as (
    select j.id
    from public.backroom_wake_jobs j
    where j.host_id = p_host_id and j.session_digest = p_session_digest
      and j.expires_at > pg_catalog.clock_timestamp()
      and j.attempt_count < 5
      and (
        (j.state = 'pending' and j.available_at <= pg_catalog.clock_timestamp())
        or (j.state = 'leased' and j.lease_expires_at <= pg_catalog.clock_timestamp())
      )
    order by j.created_at, j.id
    for update skip locked
    limit p_limit
  ),
  minted as (
    select c.id, pg_catalog.gen_random_uuid()::text as token
    from candidates c
  ),
  leased as (
    update public.backroom_wake_jobs j
    set state = 'leased',
        lease_owner = p_host_id,
        lease_token_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(m.token, 'UTF8')), 'hex'),
        lease_expires_at = least(pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds), j.expires_at),
        attempt_count = j.attempt_count + 1,
        updated_at = pg_catalog.clock_timestamp()
    from minted m
    where j.id = m.id
    returning j.id as job_id, j.job_key, j.event_id, j.owner_id, j.room_id, j.participant_id,
      j.space_id, j.session_id, j.binding_id, j.target_id, j.target_identity_fingerprint, j.target_revision, j.prompt,
      j.prompt_digest, j.attempt_count, j.expires_at, m.token as lease_token
  )
  select leased.job_id, leased.job_key, leased.event_id, leased.owner_id, leased.room_id,
    leased.participant_id, leased.space_id, leased.session_id, leased.binding_id, leased.target_id,
    leased.target_identity_fingerprint, leased.target_revision, leased.prompt, leased.prompt_digest,
    leased.attempt_count, leased.expires_at, leased.lease_token
  from leased;
end;
$claim$;

create or replace function public.ack_backroom_wake_job(
  p_job_id uuid,
  p_host_id text,
  p_session_digest text,
  p_lease_token text,
  p_outcome text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $ack$
declare v_changed integer;
begin
  if p_job_id is null or p_host_id is null or char_length(btrim(p_host_id)) not between 1 and 128
    or p_session_digest is null or p_session_digest !~ '^[0-9a-f]{64}$'
    or p_lease_token is null or p_lease_token !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or p_outcome is null or p_outcome not in ('acknowledged','ignored') then
    raise exception 'Invalid Backroom acknowledgement';
  end if;
  update public.backroom_wake_jobs j
  set state = p_outcome, acknowledged_at = pg_catalog.clock_timestamp(),
      lease_owner = null, lease_token_hash = null, lease_expires_at = null,
      updated_at = pg_catalog.clock_timestamp()
  where j.id = p_job_id and j.host_id = p_host_id and j.session_digest = p_session_digest
    and j.state = 'leased' and j.lease_owner = p_host_id
    and j.lease_token_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_lease_token, 'UTF8')), 'hex')
    and j.lease_expires_at > pg_catalog.clock_timestamp() and j.expires_at > pg_catalog.clock_timestamp()
    and exists (
      select 1 from public.rub_minds_mcp_sessions s
      where s.session_digest = p_session_digest and s.room_id = j.room_id
        and s.participant_id = j.participant_id and s.agent_credential_ciphertext is not null
        and s.terminated_at is null and s.expires_at > pg_catalog.clock_timestamp()
    );
  get diagnostics v_changed = row_count;
  return v_changed = 1;
end;
$ack$;

create or replace function public.retry_backroom_wake_job(
  p_job_id uuid,
  p_host_id text,
  p_session_digest text,
  p_lease_token text,
  p_retry_after_seconds integer,
  p_error_code text default 'other'
)
returns text
language plpgsql
security definer
set search_path = ''
as $retry$
declare v_state text;
begin
  if p_job_id is null or p_host_id is null or char_length(btrim(p_host_id)) not between 1 and 128
    or p_session_digest is null or p_session_digest !~ '^[0-9a-f]{64}$'
    or p_lease_token is null or p_lease_token !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or p_retry_after_seconds is null or p_retry_after_seconds < 1 or p_retry_after_seconds > 300
    or p_error_code is null or p_error_code not in ('target_unavailable','approval_required','provider_busy','transport_error','result_unconfirmed','authorization_denied','other') then
    raise exception 'Invalid Backroom retry parameters';
  end if;
  update public.backroom_wake_jobs j
  set state = case when j.attempt_count >= 5 or j.expires_at <= pg_catalog.clock_timestamp() then 'failed' else 'pending' end,
      available_at = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_retry_after_seconds),
      lease_owner = null, lease_token_hash = null, lease_expires_at = null,
      last_error_code = case when j.attempt_count >= 5 then 'max_attempts' else p_error_code end,
      updated_at = pg_catalog.clock_timestamp()
  where j.id = p_job_id and j.host_id = p_host_id and j.session_digest = p_session_digest
    and j.state = 'leased' and j.lease_owner = p_host_id
    and j.lease_token_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_lease_token, 'UTF8')), 'hex')
    and j.lease_expires_at > pg_catalog.clock_timestamp() and j.expires_at > pg_catalog.clock_timestamp()
    and exists (
      select 1 from public.rub_minds_mcp_sessions s
      where s.session_digest = p_session_digest and s.room_id = j.room_id
        and s.participant_id = j.participant_id and s.agent_credential_ciphertext is not null
        and s.terminated_at is null and s.expires_at > pg_catalog.clock_timestamp()
    )
  returning j.state into v_state;
  return v_state;
end;
$retry$;

create or replace function public.cancel_backroom_wake_job(p_job_id uuid, p_owner_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $cancel$
declare v_changed integer;
begin
  if p_job_id is null or p_owner_id is null then raise exception 'Job and owner are required'; end if;
  update public.backroom_wake_jobs j
  set state = 'cancelled', lease_owner = null, lease_token_hash = null, lease_expires_at = null,
      updated_at = pg_catalog.clock_timestamp()
  where j.id = p_job_id and j.owner_id = p_owner_id and j.state in ('pending','leased');
  get diagnostics v_changed = row_count;
  return v_changed = 1;
end;
$cancel$;

create or replace function public.expire_backroom_wake_jobs()
returns integer
language plpgsql
security definer
set search_path = ''
as $expire$
declare v_changed integer;
begin
  update public.backroom_wake_jobs j
  set state = 'expired', lease_owner = null, lease_token_hash = null, lease_expires_at = null,
      updated_at = pg_catalog.clock_timestamp()
  where j.state in ('pending','leased') and j.expires_at <= pg_catalog.clock_timestamp();
  get diagnostics v_changed = row_count;
  return v_changed;
end;
$expire$;

revoke all on function public.enqueue_backroom_wake_job(text,uuid,uuid,uuid,text,text,text,text,text,text,text,integer,text,text,integer) from public, anon, authenticated;
revoke all on function public.claim_backroom_wake_jobs(text,text,integer,integer) from public, anon, authenticated;
revoke all on function public.ack_backroom_wake_job(uuid,text,text,text,text) from public, anon, authenticated;
revoke all on function public.retry_backroom_wake_job(uuid,text,text,text,integer,text) from public, anon, authenticated;
revoke all on function public.cancel_backroom_wake_job(uuid,uuid) from public, anon, authenticated;
revoke all on function public.expire_backroom_wake_jobs() from public, anon, authenticated;
grant execute on function public.enqueue_backroom_wake_job(text,uuid,uuid,uuid,text,text,text,text,text,text,integer,text,text,integer) to service_role;
grant execute on function public.claim_backroom_wake_jobs(text,text,integer,integer) to service_role;
grant execute on function public.ack_backroom_wake_job(uuid,text,text,text,text) to service_role;
grant execute on function public.retry_backroom_wake_job(uuid,text,text,text,integer,text) to service_role;
grant execute on function public.cancel_backroom_wake_job(uuid,uuid) to service_role;
grant execute on function public.expire_backroom_wake_jobs() to service_role;
