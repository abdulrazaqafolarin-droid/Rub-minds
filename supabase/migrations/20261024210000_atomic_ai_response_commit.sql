-- Commit one autonomous reply and finish its job in the SAME transaction.
-- Service-role only. No model credentials, invitations, or private session state are stored here.
-- The worker must generate a reply outside this transaction and call this RPC
-- while its lease is still valid. Retried model invocations can occur, but only
-- one logical message can be committed for the job.

create or replace function private.commit_ai_response_job(
  p_job_id bigint,
  p_lease_token uuid,
  p_body text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  job private.ai_response_jobs%rowtype;
  result_id uuid;
  source_id text;
begin
  if p_body is null or char_length(btrim(p_body)) < 1 or char_length(p_body) > 10000 then
    raise exception 'Invalid autonomous reply body';
  end if;

  select * into job
  from private.ai_response_jobs j
  where j.id = p_job_id
  for update;

  if not found or job.status <> 'leased'
     or job.lease_token is distinct from p_lease_token
     or job.leased_until <= now() then
    raise exception 'Autonomous job lease is invalid or expired';
  end if;

  -- Re-check membership, source and opt-in at the exact commit boundary.
  if not exists (
    select 1
    from private.room_ai_responders r
    join public.participants target
      on target.id = r.participant_id and target.room_id = r.room_id
    join public.messages trigger_message
      on trigger_message.id = job.triggering_message_id
     and trigger_message.room_id = job.room_id
    join public.participants sender
      on sender.id = trigger_message.sender_id
     and sender.room_id = job.room_id
    where r.room_id = job.room_id
      and r.participant_id = job.target_participant_id
      and r.enabled = true
      and r.policy_version = job.policy_version
      and target.kind in ('model', 'external_agent')
      and target.status = 'autonomous'
      and sender.kind = 'human'
  ) then
    raise exception 'Autonomous responder authorization is no longer valid';
  end if;

  source_id := 'auto-job:' || job.id::text;
  insert into public.messages(room_id, sender_id, body, source_message_id)
  values (job.room_id, job.target_participant_id, p_body, source_id)
  on conflict (sender_id, source_message_id) where source_message_id is not null
  do nothing
  returning id into result_id;

  if result_id is null then
    select m.id into result_id
    from public.messages m
    where m.sender_id = job.target_participant_id
      and m.source_message_id = source_id
      and m.room_id = job.room_id;
  end if;
  if result_id is null then
    raise exception 'Autonomous reply deduplication failed';
  end if;

  update private.ai_response_jobs
  set status = 'completed', lease_token = null, leased_until = null,
      completed_at = now(), updated_at = now(), last_error_code = null
  where id = job.id;

  return result_id;
end;
$function$;

revoke all on function private.commit_ai_response_job(bigint, uuid, text) from public, anon, authenticated;
grant execute on function private.commit_ai_response_job(bigint, uuid, text) to service_role;

comment on function private.commit_ai_response_job(bigint, uuid, text) is
  'Atomically rechecks opt-in, commits one idempotent autonomous reply, and completes its leased job.';
