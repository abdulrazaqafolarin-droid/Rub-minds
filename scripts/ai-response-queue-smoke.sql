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
