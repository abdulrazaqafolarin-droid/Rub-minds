-- Smoke test for the durable AI response queue.
-- Run only against a disposable local Supabase database after migrations.
-- Requires at least one auth user, created by local-human-invite-e2e.mjs.

begin;

do $test$
declare
  v_owner_id uuid;
  v_room_id uuid;
  v_human_id uuid;
  v_responder_id uuid;
  v_message_id uuid;
  v_queued_count integer;
  v_claimed_job private.ai_response_jobs%rowtype;
  v_second_claim_count integer;
  v_retry_job private.ai_response_jobs%rowtype;
  v_reply_id uuid;
  v_commit_job private.ai_response_jobs%rowtype;
begin
  select u.id into v_owner_id
  from auth.users u
  order by u.created_at desc
  limit 1;

  if v_owner_id is null then
    raise exception 'Queue smoke test needs a disposable auth user';
  end if;

  insert into public.rooms(owner_id, title, objective)
  values (v_owner_id, 'AI queue smoke test', 'Disposable CI fixture')
  returning id into v_room_id;

  insert into public.participants(room_id, user_id, display_name, kind, status)
  values (v_room_id, v_owner_id, 'Queue test human', 'human', 'connected')
  returning id into v_human_id;

  insert into public.participants(room_id, display_name, kind, status)
  values (v_room_id, 'Queue test responder', 'external_agent', 'autonomous')
  returning id into v_responder_id;

  insert into private.room_ai_responders(room_id, participant_id, enabled, policy_version, created_by)
  values (v_room_id, v_responder_id, true, 1, v_owner_id);

  insert into public.messages(room_id, sender_id, body)
  values (v_room_id, v_human_id, 'Queue smoke test human message')
  returning id into v_message_id;

  select count(*) into v_queued_count
  from private.ai_response_jobs j
  where j.room_id = v_room_id and j.triggering_message_id = v_message_id
    and j.target_participant_id = v_responder_id and j.policy_version = 1;

  if v_queued_count <> 1 then
    raise exception 'Eligible human message should enqueue exactly one job, got %', v_queued_count;
  end if;

  -- AI-authored messages must not fan out to other responders.
  insert into public.messages(room_id, sender_id, body)
  values (v_room_id, v_responder_id, 'AI message must not fan out');

  select count(*) into v_queued_count
  from private.ai_response_jobs j
  where j.room_id = v_room_id;
  if v_queued_count <> 1 then
    raise exception 'AI-authored message unexpectedly created a job';
  end if;

  -- Pausing the responder must prevent future jobs.
  update private.room_ai_responders
     set enabled = false
   where room_id = v_room_id and participant_id = v_responder_id;

  insert into public.messages(room_id, sender_id, body)
  values (v_room_id, v_human_id, 'Paused responder must not be queued');

  select count(*) into v_queued_count
  from private.ai_response_jobs j
  where j.room_id = v_room_id;
  if v_queued_count <> 1 then
    raise exception 'Paused responder unexpectedly received a job';
  end if;

  update private.room_ai_responders
     set enabled = true
   where room_id = v_room_id and participant_id = v_responder_id;

  -- Claim must be atomic and a leased job must not be claimable a second time.
  select * into v_claimed_job
  from private.claim_ai_response_jobs(1, 60, 5)
  limit 1;

  if v_claimed_job.id is null or v_claimed_job.status <> 'leased' or v_claimed_job.attempts <> 1 then
    raise exception 'Expected one leased job with attempts=1';
  end if;

  select count(*) into v_second_claim_count
  from private.claim_ai_response_jobs(1, 60, 5);
  if v_second_claim_count <> 0 then
    raise exception 'An active lease was claimed by a second worker';
  end if;

  if private.finish_ai_response_job(v_claimed_job.id, gen_random_uuid()) then
    raise exception 'A wrong lease token must not complete a job';
  end if;

  if not private.finish_ai_response_job(v_claimed_job.id, v_claimed_job.lease_token) then
    raise exception 'The valid lease token should complete the job';
  end if;

  if not exists (
    select 1 from private.ai_response_jobs j
    where j.id = v_claimed_job.id and j.status = 'completed' and j.completed_at is not null
  ) then
    raise exception 'Completed job state was not persisted';
  end if;

  -- An expired lease must not be able to finish or retry a job.
  insert into public.messages(room_id, sender_id, body)
  values (v_room_id, v_human_id, 'Lease expiry regression test');

  select * into v_retry_job
  from private.claim_ai_response_jobs(1, 60, 5)
  limit 1;

  if v_retry_job.id is null then
    raise exception 'Expected a second claim for lease expiry test';
  end if;

  update private.ai_response_jobs
     set leased_until = now() - interval '1 second'
   where id = v_retry_job.id;

  if private.finish_ai_response_job(v_retry_job.id, v_retry_job.lease_token)
     or private.retry_ai_response_job(v_retry_job.id, v_retry_job.lease_token, 'timeout', 5) then
    raise exception 'Expired lease token must not transition a job';
  end if;

  select * into v_retry_job
  from private.claim_ai_response_jobs(1, 60, 5)
  limit 1;

  if v_retry_job.id is null or v_retry_job.attempts <> 2 then
    raise exception 'Expired lease should be reclaimed with attempts=2';
  end if;

  if not private.retry_ai_response_job(v_retry_job.id, v_retry_job.lease_token, 'timeout', 5) then
    raise exception 'Valid retry should transition the job';
  end if;

  if not exists (
    select 1 from private.ai_response_jobs j
    where j.id = v_retry_job.id and j.status = 'pending'
      and j.lease_token is null and j.available_at > now()
  ) then
    raise exception 'Retry should clear lease and apply backoff';
  end if;

  -- A valid lease commits exactly one message and completes the job.
  insert into public.messages(room_id, sender_id, body)
  values (v_room_id, v_human_id, 'Atomic commit test');
  select * into v_commit_job
  from private.claim_ai_response_jobs(1, 60, 5)
  limit 1;
  if v_commit_job.id is null then
    raise exception 'Expected claim for atomic commit test';
  end if;
  select private.commit_ai_response_job(v_commit_job.id, v_commit_job.lease_token, 'Autonomous test reply')
    into v_reply_id;
  if v_reply_id is null or not exists (
    select 1 from public.messages m
    where m.id = v_reply_id and m.room_id = v_room_id
      and m.sender_id = v_responder_id
      and m.source_message_id = 'auto-job:' || v_commit_job.id::text
  ) then
    raise exception 'Atomic commit failed to persist idempotent reply';
  end if;
  if (select count(*) from public.messages m
      where m.sender_id = v_responder_id
        and m.source_message_id = 'auto-job:' || v_commit_job.id::text) <> 1 then
    raise exception 'Autonomous reply must be unique';
  end if;
  if (select status from private.ai_response_jobs where id = v_commit_job.id) <> 'completed' then
    raise exception 'Atomic commit must complete its job';
  end if;

  -- Disabling an agent between claim and commit must block the reply.
  insert into public.messages(room_id, sender_id, body)
  values (v_room_id, v_human_id, 'Revocation race test');
  select * into v_commit_job
  from private.claim_ai_response_jobs(1, 60, 5)
  limit 1;
  if v_commit_job.id is null then
    raise exception 'Expected claim for revocation test';
  end if;
  update private.room_ai_responders set enabled = false
  where room_id = v_room_id and participant_id = v_responder_id;
  begin
    perform private.commit_ai_response_job(v_commit_job.id, v_commit_job.lease_token, 'Must be rejected');
    raise exception 'Disabled responder unexpectedly committed a reply';
  exception when others then
    if sqlerrm = 'Disabled responder unexpectedly committed a reply' then raise; end if;
  end;
  if exists (
    select 1 from public.messages m
    where m.sender_id = v_responder_id
      and m.source_message_id = 'auto-job:' || v_commit_job.id::text
  ) then
    raise exception 'Revoked responder reply was persisted';
  end if;

  if has_schema_privilege('anon', 'private', 'USAGE')
     or has_schema_privilege('authenticated', 'private', 'USAGE')
     or has_table_privilege('anon', 'private.ai_response_jobs', 'SELECT')
     or has_table_privilege('authenticated', 'private.ai_response_jobs', 'SELECT') then
    raise exception 'Client roles must not access the private queue';
  end if;

  if has_function_privilege('anon', 'private.claim_ai_response_jobs(integer,integer,integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'private.claim_ai_response_jobs(integer,integer,integer)', 'EXECUTE')
     or not has_function_privilege('service_role', 'private.claim_ai_response_jobs(integer,integer,integer)', 'EXECUTE') then
    raise exception 'Queue claim RPC grants are incorrect';
  end if;
end;
$test$;

rollback;
