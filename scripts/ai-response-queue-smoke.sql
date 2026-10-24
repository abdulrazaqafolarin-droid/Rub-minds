-- Smoke test for the durable AI response queue.
-- Run only against a disposable local Supabase database after migrations.
-- Requires at least one auth user, created by local-human-invite-e2e.mjs.

begin;

do $test$
declare
  owner_id uuid;
  room_id uuid;
  human_id uuid;
  responder_id uuid;
  message_id uuid;
  queued_count integer;
  claimed_job private.ai_response_jobs%rowtype;
  second_claim_count integer;
begin
  select u.id into owner_id
  from auth.users u
  order by u.created_at desc
  limit 1;

  if owner_id is null then
    raise exception 'Queue smoke test needs a disposable auth user';
  end if;

  insert into public.rooms(owner_id, title, objective)
  values (owner_id, 'AI queue smoke test', 'Disposable CI fixture')
  returning id into room_id;

  insert into public.participants(room_id, user_id, display_name, kind, status)
  values (room_id, owner_id, 'Queue test human', 'human', 'connected')
  returning id into human_id;

  insert into public.participants(room_id, display_name, kind, status)
  values (room_id, 'Queue test responder', 'external_agent', 'autonomous')
  returning id into responder_id;

  insert into private.room_ai_responders(room_id, participant_id, enabled, policy_version, created_by)
  values (room_id, responder_id, true, 1, owner_id);

  insert into public.messages(room_id, sender_id, body)
  values (room_id, human_id, 'Queue smoke test human message')
  returning id into message_id;

  select count(*) into queued_count
  from private.ai_response_jobs
  where room_id = room_id and triggering_message_id = message_id
    and target_participant_id = responder_id and policy_version = 1;

  if queued_count <> 1 then
    raise exception 'Eligible human message should enqueue exactly one job, got %', queued_count;
  end if;

  -- AI-authored messages must not fan out to other responders.
  insert into public.messages(room_id, sender_id, body)
  values (room_id, responder_id, 'AI message must not fan out');

  select count(*) into queued_count
  from private.ai_response_jobs
  where room_id = room_id;
  if queued_count <> 1 then
    raise exception 'AI-authored message unexpectedly created a job';
  end if;

  -- Pausing the responder must prevent future jobs.
  update private.room_ai_responders set enabled = false
  where room_id = room_id and participant_id = responder_id;

  insert into public.messages(room_id, sender_id, body)
  values (room_id, human_id, 'Paused responder must not be queued');

  select count(*) into queued_count
  from private.ai_response_jobs
  where room_id = room_id;
  if queued_count <> 1 then
    raise exception 'Paused responder unexpectedly received a job';
  end if;

  update private.room_ai_responders set enabled = true
  where room_id = room_id and participant_id = responder_id;

  -- Claim must be atomic and a leased job must not be claimable a second time.
  select * into claimed_job
  from private.claim_ai_response_jobs(1, 60, 5)
  limit 1;

  if claimed_job.id is null or claimed_job.status <> 'leased' or claimed_job.attempts <> 1 then
    raise exception 'Expected one leased job with attempts=1';
  end if;

  select count(*) into second_claim_count
  from private.claim_ai_response_jobs(1, 60, 5);
  if second_claim_count <> 0 then
    raise exception 'An active lease was claimed by a second worker';
  end if;

  if private.finish_ai_response_job(claimed_job.id, gen_random_uuid()) then
    raise exception 'A wrong lease token must not complete a job';
  end if;

  if not private.finish_ai_response_job(claimed_job.id, claimed_job.lease_token) then
    raise exception 'The valid lease token should complete the job';
  end if;

  if not exists (
    select 1 from private.ai_response_jobs
    where id = claimed_job.id and status = 'completed' and completed_at is not null
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
